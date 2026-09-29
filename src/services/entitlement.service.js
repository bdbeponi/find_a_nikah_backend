import { Subscription } from "../models/subscription.model.js";

/**
 * What an unpaid member gets.
 *
 * Every gated check reads this when there is no live subscription, so a member
 * whose plan lapsed falls back to exactly these rather than to `undefined` -
 * which would read as false everywhere and as "no limit" on the like counter.
 */
export const FREE_FEATURES = {
  maxLikesPerDay: 10,
  canMessageBeforeMatch: false,
  canSeeWhoLikedMe: false,
  canSeeContactDetails: false,
  boostedInSearch: false,
};

/**
 * The features this member currently has.
 *
 * Read from the subscription's own snapshot, not from the plan: an admin
 * editing a plan must not change what somebody already paid for. See the note
 * on featuresSnapshot.
 *
 * `endsAt` is compared here rather than trusted from `status`, because the
 * sweep that marks a subscription expired runs on a schedule and the gap
 * between "it ended" and "somebody noticed" is exactly when this gets asked.
 */
export const getEntitlements = async (userId) => {
  const subscription = await Subscription.findOne({
    userId,
    status: "active",
    endsAt: { $gt: new Date() },
  }).lean();

  if (!subscription) return { ...FREE_FEATURES, isSubscribed: false, plan: null };

  return {
    ...FREE_FEATURES,
    ...(subscription.featuresSnapshot || {}),
    isSubscribed: true,
    plan: subscription.planId,
    endsAt: subscription.endsAt,
  };
};
