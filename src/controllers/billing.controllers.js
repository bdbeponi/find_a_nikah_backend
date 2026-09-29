import crypto from "node:crypto";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { Subscription } from "../models/subscription.model.js";
import { Payment } from "../models/payment.model.js";
import {
  activateFromPayment,
  repairUnappliedPayments,
  verifyWebhookSignature,
} from "../services/payment.service.js";
import { getEntitlements } from "../services/entitlement.service.js";
import { buildPaginationMeta, getPagination } from "../utils/pagination.js";

/** GET /api/v1/plans - the catalogue. No session needed. */
const listPlans = asyncHandler(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true })
    .sort({ serial: 1, priceMinor: 1 })
    .lean();

  return res.status(200).json(new ApiResponse(200, plans, "Plans"));
});

/** GET /api/v1/plans/:slug */
const getPlan = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findOne({
    slug: req.params.slug,
    isActive: true,
  }).lean();

  if (!plan) throw new ApiError(404, "Plan not found");

  return res.status(200).json(new ApiResponse(200, plan, "Plan"));
});

/**
 * POST /api/v1/payments/initiate
 *
 * Creates the pending payment and hands back what the client needs to send the
 * member to the gateway. The amount is read from the plan, never from the body:
 * a price in a request is a price the customer chooses.
 *
 * ponytail: no gateway SDK is wired in, so this returns our own reference and a
 * redirect URL the gateway would normally supply. The Payment row, the webhook
 * and the activation are the parts that matter and they are real; swapping in
 * bKash or SSLCOMMERZ is this function's body and nothing else.
 */
const initiatePayment = asyncHandler(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.body?.planId);
  if (!plan || !plan.isActive) throw new ApiError(404, "Plan not found");

  const gateway = String(req.body?.gateway || "manual").trim();

  const payment = await Payment.create({
    userId: req.user._id,
    planId: plan._id,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    gateway,
    status: "pending",
  });

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        paymentId: payment._id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        // What the client sends the gateway as its own order reference
        reference: String(payment._id),
      },
      "Payment started"
    )
  );
});

/**
 * POST /api/v1/payments/webhook - called by the gateway, never by a browser.
 *
 * No session, so the signature is the only thing standing between this endpoint
 * and anybody giving themselves a free subscription. The body's own "status"
 * field is never trusted on its own; it is only read once the HMAC over the raw
 * bytes has checked out.
 *
 * Idempotency is the atomic claim below: the status transition from pending is
 * the one write that can only happen once, and a gateway that retries delivery
 * - which they all do - gets a 200 and no second subscription.
 */
const paymentWebhook = asyncHandler(async (req, res) => {
  const signature =
    req.header("x-signature") || req.header("x-webhook-signature");

  if (
    !verifyWebhookSignature(
      req.rawBody,
      signature,
      process.env.PAYMENT_WEBHOOK_SECRET
    )
  ) {
    throw new ApiError(401, "Invalid signature");
  }

  const { reference, gatewayRef, status, failureReason } = req.body || {};

  const payment = await Payment.findById(reference).catch(() => null);
  if (!payment) throw new ApiError(404, "Unknown payment reference");

  if (status !== "succeeded") {
    await Payment.updateOne(
      { _id: payment._id, status: "pending" },
      { $set: { status: "failed", failureReason, gatewayRef, gatewayPayload: req.body } }
    );

    return res.status(200).json(new ApiResponse(200, null, "Recorded"));
  }

  // The claim. Only one caller can move it out of pending, so a duplicate
  // delivery falls through to the "already handled" answer below.
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: "pending" },
    {
      $set: {
        status: "succeeded",
        paidAt: new Date(),
        gatewayRef,
        gatewayPayload: req.body,
      },
    },
    { new: true }
  );

  if (!claimed) {
    return res.status(200).json(new ApiResponse(200, null, "Already handled"));
  }

  await activateFromPayment(claimed);

  return res.status(200).json(new ApiResponse(200, null, "Payment applied"));
});

/**
 * GET /api/v1/subscriptions/me
 *
 * Sweeps up any payment that was taken but never applied before answering. This
 * is where somebody who paid and saw nothing happen will look, so it is where
 * the repair belongs - see repairUnappliedPayments.
 */
const getMySubscription = asyncHandler(async (req, res) => {
  await repairUnappliedPayments(req.user._id);

  const subscription = await Subscription.findOne({ userId: req.user._id })
    .sort({ endsAt: -1 })
    .populate("planId", "name slug priceMinor durationDays")
    .lean();

  const entitlements = await getEntitlements(req.user._id);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { subscription, entitlements },
        subscription ? "Your subscription" : "No subscription"
      )
    );
});

/**
 * POST /api/v1/subscriptions/me/cancel
 *
 * Stops the renewal, it does not cut the remaining days off. Somebody who paid
 * for a month and cancelled on day two keeps twenty-eight days; taking them
 * away is a refund question, not a cancel button.
 */
const cancelMySubscription = asyncHandler(async (req, res) => {
  const subscription = await Subscription.findOne({
    userId: req.user._id,
    status: "active",
  });

  if (!subscription) throw new ApiError(404, "You have no active subscription");

  subscription.autoRenew = false;
  subscription.cancelledAt = new Date();
  await subscription.save();

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        subscription,
        `Cancelled. You keep your benefits until ${subscription.endsAt.toDateString()}`
      )
    );
});

/** GET /api/v1/payments/me */
const getMyPayments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { userId: req.user._id };

  const [payments, totalCount] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("planId", "name slug")
      .lean(),
    Payment.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { payments, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Your payments"
      )
    );
});

/**
 * POST /api/v1/payments/:id/confirm - development only.
 *
 * ponytail: stands in for the gateway while none is connected, so the mobile
 * app can be built against a real subscription today. It refuses to exist in
 * production, because what it does is hand out paid features for free.
 */
const confirmPaymentDev = asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(404, "Not found");
  }

  const claimed = await Payment.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: "pending" },
    {
      $set: {
        status: "succeeded",
        paidAt: new Date(),
        gatewayRef: `dev_${crypto.randomUUID()}`,
      },
    },
    { new: true }
  );

  if (!claimed) throw new ApiError(404, "No pending payment with that id");

  const subscription = await activateFromPayment(claimed);

  return res
    .status(200)
    .json(new ApiResponse(200, { payment: claimed, subscription }, "Payment applied"));
});

export {
  listPlans,
  getPlan,
  initiatePayment,
  paymentWebhook,
  getMySubscription,
  cancelMySubscription,
  getMyPayments,
  confirmPaymentDev,
};
