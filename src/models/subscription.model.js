import mongoose, { Schema } from "mongoose";
import { SUBSCRIPTION_STATUSES } from "../constants.js";

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    planId: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },

    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: "pending" },

    startsAt: { type: Date },
    endsAt: { type: Date },

    autoRenew: { type: Boolean, default: false },
    cancelledAt: { type: Date },

    /**
     * The plan's features copied in at purchase time.
     *
     * Deliberate duplication, against the usual rule: if an admin edits a plan
     * the people who already paid for the old terms must keep them. Reading
     * the live plan would silently change what somebody bought.
     */
    featuresSnapshot: { type: Schema.Types.Mixed },
    pricePaidMinor: { type: Number, min: 0 },
    currency: { type: String, default: "BDT" },
  },
  { timestamps: true }
);

// "is this member subscribed right now" - the entitlement check, on every
// gated action
subscriptionSchema.index({ userId: 1, status: 1, endsAt: -1 });
// The expiry sweep
subscriptionSchema.index({ status: 1, endsAt: 1 });

// Only one live subscription per member, whatever the payment flow does
subscriptionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

subscriptionSchema.methods.isLive = function () {
  return this.status === "active" && this.endsAt > new Date();
};

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
