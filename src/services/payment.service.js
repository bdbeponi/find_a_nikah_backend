import crypto from "node:crypto";
import { Subscription } from "../models/subscription.model.js";
import { Payment } from "../models/payment.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { notify } from "../services/notification.service.js";

/**
 * Whether a webhook really came from the gateway.
 *
 * Over the raw request body, not the parsed object: JSON.stringify of a parsed
 * body reorders keys and drops whitespace, so the bytes signed and the bytes
 * checked stop matching and every real callback starts failing. app.js keeps
 * the raw buffer for exactly this.
 *
 * timingSafeEqual, not ===, because a string compare returns early on the first
 * wrong byte and that timing is enough to recover a signature one byte at a
 * time.
 */
export const verifyWebhookSignature = (rawBody, signature, secret) => {
  if (!secret) return false;
  if (typeof signature !== "string" || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody ?? Buffer.alloc(0))
    .digest("hex");

  const given = Buffer.from(signature, "utf8");
  const mine = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on a length mismatch, which is itself a leak-free
  // answer: a signature of the wrong length is wrong.
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
};

/** Where a subscription bought now should end. */
export const endDateFor = (durationDays, from = new Date()) =>
  new Date(from.getTime() + durationDays * 24 * 60 * 60 * 1000);

/**
 * Turns a paid payment into time on the member's subscription.
 *
 * Idempotent on `payment.subscriptionId`: once that is set, this payment has
 * already bought its days and a second call does nothing. That is what makes it
 * safe to call from the webhook, from a gateway retry, and from the member's
 * own "my subscription" screen - which is what repairs a webhook that arrived
 * and then died halfway.
 *
 * An active subscription is extended from its own end date, not from today, so
 * renewing early does not throw away the days already paid for.
 */
export const activateFromPayment = async (payment) => {
  if (!payment || payment.status !== "succeeded") return null;
  if (payment.subscriptionId) {
    return Subscription.findById(payment.subscriptionId);
  }

  const plan = await SubscriptionPlan.findById(payment.planId).lean();
  if (!plan) return null;

  const now = new Date();
  const existing = await Subscription.findOne({
    userId: payment.userId,
    status: "active",
    endsAt: { $gt: now },
  });

  let subscription;

  if (existing) {
    existing.endsAt = endDateFor(plan.durationDays, existing.endsAt);
    // The newer plan's terms take over for the whole remaining period - the
    // alternative is two overlapping entitlement sets and a rule about which
    // one wins.
    existing.planId = plan._id;
    existing.featuresSnapshot = plan.features;
    await existing.save();
    subscription = existing;
  } else {
    subscription = await Subscription.create({
      userId: payment.userId,
      planId: plan._id,
      status: "active",
      startsAt: now,
      endsAt: endDateFor(plan.durationDays, now),
      // Copied, not referenced. An admin editing the plan must not change what
      // this member already paid for - see the note on the schema.
      featuresSnapshot: plan.features,
      pricePaidMinor: payment.amountMinor,
      currency: payment.currency,
    });
  }

  await Payment.updateOne(
    { _id: payment._id },
    { $set: { subscriptionId: subscription._id } }
  );

  await notify({
    userId: payment.userId,
    type: "system",
    title: `${plan.name} is active`,
    body: `Your subscription runs until ${subscription.endsAt.toDateString()}`,
    data: { subscriptionId: subscription._id },
  });

  return subscription;
};

/**
 * Any payment that was taken but never turned into days.
 *
 * The gap this closes: the webhook marks the payment succeeded in one atomic
 * step and then activates, and a crash in between leaves money taken and
 * nothing bought. With no transactions that window cannot be removed, so it is
 * swept instead - on the member's own subscription screen, which is where
 * somebody who has just paid and seen nothing happen will go.
 */
export const repairUnappliedPayments = async (userId) => {
  const orphans = await Payment.find({
    userId,
    status: "succeeded",
    subscriptionId: { $exists: false },
  });

  for (const payment of orphans) {
    await activateFromPayment(payment);
  }

  return orphans.length;
};

/**
 * Marks subscriptions that have run out.
 *
 * Nothing depends on this having run: getEntitlements compares endsAt itself,
 * so a member whose plan lapsed loses the features the moment it does. This
 * only keeps `status` honest for the admin lists and the unique "one active
 * subscription" index.
 */
export const expireFinished = async () => {
  const result = await Subscription.updateMany(
    { status: "active", endsAt: { $lte: new Date() } },
    { $set: { status: "expired" } }
  );

  return result.modifiedCount;
};
