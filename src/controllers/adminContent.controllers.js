import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { getPagination, buildPaginationMeta } from "../utils/pagination.js";
import { requireString } from "../utils/requireString.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { Subscription } from "../models/subscription.model.js";
import { Payment } from "../models/payment.model.js";
import { User } from "../models/user.model.js";
import { Notification } from "../models/notification.model.js";
import { recordAudit } from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { emitToUsers } from "../socket/emit.js";
import { slugify } from "../utils/slugify.js";
import {
  ACCOUNT_STATUS,
  PAYMENT_STATUSES,
  ROLES,
  SUBSCRIPTION_STATUSES,
} from "../constants.js";

/* -------------------------------------------------------------------- photos */

/**
 * The photo queue's filter.
 *
 * Pure and exported for the same reason as the other queue filters: a dropped
 * clause shows an empty queue, and an empty queue looks like a finished one.
 * "pending" is the absence of a decision, which on this schema is isApproved
 * false with no rejection reason - there is no third state to read.
 */
export const buildPhotoFilter = (query = {}) => {
  if (query.status === "approved") return { isApproved: true };
  if (query.status === "rejected") {
    return { isApproved: false, rejectionReason: { $exists: true, $ne: null } };
  }
  if (query.status === "pending") {
    return { isApproved: false, rejectionReason: { $exists: false } };
  }
  return {};
};

/** GET /api/v1/admin/photos - oldest first, so nobody waits forever. */
const listPhotos = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildPhotoFilter(req.query);

  const [photos, totalCount] = await Promise.all([
    ProfilePhoto.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName phone isVerified")
      .lean(),
    ProfilePhoto.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { photos, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Photo queue"
      )
    );
});

/**
 * PATCH /api/v1/admin/photos/:id - approve or reject.
 *
 * Order, with no transaction:
 *   1. the photo    - the decision itself, idempotent
 *   2. the member   - told, and notify never throws
 *   3. the audit    - never throws
 *
 * A rejection needs a reason. "Rejected" with no explanation produces one
 * support message per rejection, and the moderator is the only person who knows
 * why.
 */
const reviewPhoto = asyncHandler(async (req, res) => {
  const { isApproved, rejectionReason } = req.body || {};

  if (typeof isApproved !== "boolean") {
    throw new ApiError(400, "isApproved must be true or false");
  }

  const reason = isApproved ? null : requireString(rejectionReason, "A reason");

  const photo = await ProfilePhoto.findById(req.params.id);
  if (!photo) throw new ApiError(404, "Photo not found");

  await ProfilePhoto.updateOne(
    { _id: photo._id },
    isApproved
      ? { $set: { isApproved: true }, $unset: { rejectionReason: 1 } }
      : { $set: { isApproved: false, rejectionReason: reason } }
  );

  await notify({
    userId: photo.userId,
    type: isApproved ? "profile_approved" : "profile_rejected",
    title: isApproved ? "Your photo is live" : "A photo was not accepted",
    body: isApproved ? "It now shows on your profile" : reason,
    data: { photoId: photo._id },
  });

  await recordAudit({
    actor: req.user,
    action: isApproved ? "photo.approved" : "photo.rejected",
    targetType: "ProfilePhoto",
    targetId: photo._id,
    before: { isApproved: photo.isApproved },
    after: { isApproved },
    note: reason || undefined,
    ip: req.ip,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, isApproved ? "Photo approved" : "Photo rejected"));
});

/* --------------------------------------------------------------------- plans */

const PLAN_FIELDS = [
  "name",
  "description",
  "priceMinor",
  "currency",
  "durationDays",
  "features",
  "isActive",
  "serial",
];

/** GET /api/v1/admin/plans - inactive ones included, unlike the public list. */
const listPlansAdmin = asyncHandler(async (req, res) => {
  const plans = await SubscriptionPlan.find().sort({ serial: 1, priceMinor: 1 }).lean();

  // What each plan is actually worth, which is the only number anybody asks of
  // this screen.
  const sold = await Subscription.aggregate([
    { $group: { _id: "$planId", subscribers: { $sum: 1 } } },
  ]);

  const soldByPlan = new Map(sold.map((row) => [String(row._id), row.subscribers]));

  return res.status(200).json(
    new ApiResponse(
      200,
      plans.map((plan) => ({
        ...plan,
        subscribers: soldByPlan.get(String(plan._id)) || 0,
      })),
      "Plans"
    )
  );
});

const pickPlanFields = (body = {}) => {
  const doc = {};
  for (const field of PLAN_FIELDS) {
    if (body[field] !== undefined) doc[field] = body[field];
  }
  return doc;
};

/** POST /api/v1/admin/plans */
const createPlan = asyncHandler(async (req, res) => {
  const doc = pickPlanFields(req.body);

  doc.name = requireString(doc.name, "Name");
  if (!Number.isFinite(Number(doc.priceMinor))) {
    throw new ApiError(400, "Price is required, in the smallest currency unit");
  }
  if (!Number.isFinite(Number(doc.durationDays)) || Number(doc.durationDays) < 1) {
    throw new ApiError(400, "Duration must be at least one day");
  }

  const plan = await SubscriptionPlan.create({ ...doc, slug: slugify(doc.name) });

  await recordAudit({
    actor: req.user,
    action: "plan.created",
    targetType: "SubscriptionPlan",
    targetId: plan._id,
    after: { name: plan.name, priceMinor: plan.priceMinor },
    ip: req.ip,
  });

  return res.status(201).json(new ApiResponse(201, plan, "Plan created"));
});

/**
 * PATCH /api/v1/admin/plans/:id
 *
 * Editing a plan does not touch anybody who has already bought it: their terms
 * were copied onto their subscription at purchase. See featuresSnapshot.
 */
const updatePlan = asyncHandler(async (req, res) => {
  const before = await SubscriptionPlan.findById(req.params.id).lean();
  if (!before) throw new ApiError(404, "Plan not found");

  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    { $set: pickPlanFields(req.body) },
    { new: true, runValidators: true }
  );

  await recordAudit({
    actor: req.user,
    action: "plan.updated",
    targetType: "SubscriptionPlan",
    targetId: plan._id,
    before: { priceMinor: before.priceMinor, isActive: before.isActive },
    after: { priceMinor: plan.priceMinor, isActive: plan.isActive },
    ip: req.ip,
  });

  return res.status(200).json(new ApiResponse(200, plan, "Plan updated"));
});

/**
 * DELETE /api/v1/admin/plans/:id - retires it, never removes it.
 *
 * Payments and subscriptions point at this row. A real delete would leave every
 * past receipt referring to a plan that no longer exists.
 */
const retirePlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: false } },
    { new: true }
  );

  if (!plan) throw new ApiError(404, "Plan not found");

  await recordAudit({
    actor: req.user,
    action: "plan.retired",
    targetType: "SubscriptionPlan",
    targetId: plan._id,
    ip: req.ip,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, plan, "Plan retired - existing subscribers keep it"));
});

/* ------------------------------------------------------------------ payments */

export const buildPaymentFilter = (query = {}) => {
  const filter = {};
  if (PAYMENT_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.gateway) filter.gateway = String(query.gateway).trim();
  return filter;
};

/**
 * GET /api/v1/admin/payments
 *
 * The totals are computed over the filter, not over the page: "this page adds
 * up to 12,000" is a number nobody wants.
 */
const listPayments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildPaymentFilter(req.query);

  const [payments, totalCount, totals] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName phone")
      .populate("planId", "name")
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: { ...filter, status: "succeeded" } },
      { $group: { _id: null, amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        payments,
        revenue: {
          amountMinor: totals[0]?.amountMinor || 0,
          count: totals[0]?.count || 0,
        },
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "Payments"
    )
  );
});

/**
 * PATCH /api/v1/admin/payments/:id/refund
 *
 * Records a refund that has already been made at the gateway - nothing here
 * moves money - and takes back the days it bought.
 *
 * Order, with no transaction:
 *   1. mark the payment refunded  - the decision, and the audit trail for it
 *   2. end the subscription       - the consequence
 *
 * A crash in between leaves a refunded payment with a live subscription: the
 * member keeps access they were refunded for, which is visible on this screen
 * and fixed by pressing the button again - the handler is idempotent and will
 * finish the job on an already-refunded payment. The other order would take
 * somebody's access away while the books still said they had paid, and nobody
 * would know to go looking.
 */
const refundPayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw new ApiError(404, "Payment not found");

  if (payment.status === "pending") {
    throw new ApiError(409, "That payment never completed - there is nothing to refund");
  }

  const alreadyRefunded = payment.status === "refunded";

  if (!alreadyRefunded) {
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: "refunded",
          refundedAt: new Date(),
          failureReason: req.body?.reason,
        },
      }
    );
  }

  // Re-run whether or not step 1 just happened, so a second press repairs a
  // first attempt that died in the middle.
  let endedSubscription = false;
  if (payment.subscriptionId) {
    const result = await Subscription.updateOne(
      { _id: payment.subscriptionId, status: "active" },
      { $set: { status: "cancelled", cancelledAt: new Date(), endsAt: new Date() } }
    );
    endedSubscription = result.modifiedCount > 0;
  }

  await recordAudit({
    actor: req.user,
    action: "payment.refunded",
    targetType: "Payment",
    targetId: payment._id,
    before: { status: payment.status },
    after: { status: "refunded" },
    note: req.body?.reason,
    ip: req.ip,
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      { endedSubscription },
      alreadyRefunded
        ? "Already refunded - the subscription has been checked again"
        : "Refunded"
    )
  );
});

/** GET /api/v1/admin/subscriptions */
const listSubscriptions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};
  if (SUBSCRIPTION_STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }

  // "expiring" is a question about time, not about status, and it is the one
  // the team actually asks this screen.
  if (req.query.expiring === "true") {
    filter.status = "active";
    filter.endsAt = {
      $gte: new Date(),
      $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  const [subscriptions, totalCount] = await Promise.all([
    Subscription.find(filter)
      .sort({ endsAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName phone")
      .populate("planId", "name")
      .lean(),
    Subscription.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { subscriptions, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Subscriptions"
      )
    );
});

/**
 * POST /api/v1/admin/subscriptions - grant one by hand.
 *
 * For the member who paid over bKash personal, or the one being made good after
 * a support failure. It writes a Payment row too, marked with this gateway, so
 * the revenue figures stay honest about what was and was not actually taken.
 */
const grantSubscription = asyncHandler(async (req, res) => {
  const { userId, planId, note } = req.body || {};

  const [user, plan] = await Promise.all([
    User.findById(userId).select("fullName"),
    SubscriptionPlan.findById(planId).lean(),
  ]);

  if (!user) throw new ApiError(404, "Member not found");
  if (!plan) throw new ApiError(404, "Plan not found");

  const now = new Date();
  const endsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  const existing = await Subscription.findOne({
    userId,
    status: "active",
    endsAt: { $gt: now },
  });

  let subscription;
  if (existing) {
    existing.endsAt = new Date(
      existing.endsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000
    );
    existing.planId = plan._id;
    existing.featuresSnapshot = plan.features;
    await existing.save();
    subscription = existing;
  } else {
    subscription = await Subscription.create({
      userId,
      planId: plan._id,
      status: "active",
      startsAt: now,
      endsAt,
      featuresSnapshot: plan.features,
      pricePaidMinor: 0,
      currency: plan.currency,
    });
  }

  await Payment.create({
    userId,
    planId: plan._id,
    subscriptionId: subscription._id,
    amountMinor: 0,
    currency: plan.currency,
    gateway: "admin_grant",
    status: "succeeded",
    paidAt: now,
  });

  await notify({
    userId,
    type: "system",
    title: `${plan.name} is active`,
    body: `Your subscription runs until ${subscription.endsAt.toDateString()}`,
    data: { subscriptionId: subscription._id },
  });

  await recordAudit({
    actor: req.user,
    action: "subscription.granted",
    targetType: "Subscription",
    targetId: subscription._id,
    after: { plan: plan.name, endsAt: subscription.endsAt },
    note,
    ip: req.ip,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, subscription, `${plan.name} granted to ${user.fullName}`));
});

/**
 * PATCH /api/v1/admin/subscriptions/:id
 *
 * Two different things a support agent means by "cancel":
 *
 *   stopRenewal - the member keeps the days they paid for, nothing renews.
 *                 This is what the member's own cancel button does.
 *   endNow      - access stops today. Taking back days somebody paid for is a
 *                 refund decision, so it is a separate, deliberate flag rather
 *                 than something "cancel" quietly does.
 */
const updateSubscription = asyncHandler(async (req, res) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) throw new ApiError(404, "Subscription not found");

  const { endNow, note } = req.body || {};
  const before = { status: subscription.status, endsAt: subscription.endsAt };

  subscription.autoRenew = false;
  subscription.cancelledAt = subscription.cancelledAt || new Date();

  if (endNow === true) {
    subscription.status = "cancelled";
    subscription.endsAt = new Date();
  }

  await subscription.save();

  await recordAudit({
    actor: req.user,
    action: endNow === true ? "subscription.ended" : "subscription.cancelled",
    targetType: "Subscription",
    targetId: subscription._id,
    before,
    after: { status: subscription.status, endsAt: subscription.endsAt },
    note,
    ip: req.ip,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        subscription,
        endNow === true
          ? "Ended - access stops now"
          : `Will not renew. Access runs to ${subscription.endsAt.toDateString()}`
      )
    );
});

/* ------------------------------------------------------------ announcements */

/** Who a broadcast goes to. Exported so the check script can pin it. */
export const buildAudienceFilter = (audience) => {
  const filter = { role: ROLES.MEMBER, accountStatus: ACCOUNT_STATUS.ACTIVE };
  if (audience === "verified") filter.isVerified = true;
  return filter;
};

/**
 * POST /api/v1/admin/notifications - an announcement to every member.
 *
 * insertMany, not a create per member: a hundred thousand round trips is a
 * different kind of endpoint. It is chunked because one insertMany of every
 * member is a single document larger than Mongo will accept, and `ordered:
 * false` means one bad row does not abandon the rest of the batch.
 *
 * ponytail: writes the rows inline, so a very large audience makes this request
 * slow. Move it to a queue when "slow" becomes "times out" - the shape here
 * does not change, only who runs it.
 */
const broadcast = asyncHandler(async (req, res) => {
  const title = requireString(req.body?.title, "Title");
  const body = req.body?.body ? String(req.body.body).slice(0, 1000) : undefined;
  const audience = req.body?.audience === "verified" ? "verified" : "all";

  const recipients = await User.find(buildAudienceFilter(audience)).distinct("_id");

  if (!recipients.length) {
    throw new ApiError(404, "Nobody matches that audience");
  }

  const CHUNK = 1000;
  let sent = 0;

  for (let i = 0; i < recipients.length; i += CHUNK) {
    const rows = recipients.slice(i, i + CHUNK).map((userId) => ({
      userId,
      type: "system",
      title,
      body,
      data: { announcement: true },
    }));

    const inserted = await Notification.insertMany(rows, { ordered: false });
    sent += inserted.length;

    // Pushed to whoever is connected, exactly as notify() would have
    emitToUsers(
      rows.map((row) => row.userId),
      "notification:new",
      { type: "system", title, body }
    );
  }

  await recordAudit({
    actor: req.user,
    action: "notification.broadcast",
    targetType: "Notification",
    targetId: req.user._id,
    after: { audience, recipients: sent },
    note: title,
    ip: req.ip,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, { sent }, `Sent to ${sent} members`));
});

export {
  listPhotos,
  reviewPhoto,
  listPlansAdmin,
  createPlan,
  updatePlan,
  retirePlan,
  listPayments,
  refundPayment,
  listSubscriptions,
  updateSubscription,
  grantSubscription,
  broadcast,
};
