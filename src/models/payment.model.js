import mongoose, { Schema } from "mongoose";
import { PAYMENT_STATUSES } from "../constants.js";

const paymentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    planId: { type: Schema.Types.ObjectId, ref: "SubscriptionPlan" },
    subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription" },

    // Integer minor units. See the note in subscriptionPlan.model.js.
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "BDT", uppercase: true, maxlength: 3 },

    gateway: { type: String, required: true, trim: true },

    /**
     * The gateway's own id for this transaction.
     *
     * Unique, and that is the whole defence against a replayed webhook: a
     * gateway that retries delivery - which they all do - would otherwise
     * extend the subscription twice for one payment. The handler inserts on
     * this key and treats a duplicate as "already processed".
     */
    gatewayRef: { type: String, unique: true, sparse: true },

    status: { type: String, enum: PAYMENT_STATUSES, default: "pending" },
    failureReason: { type: String, trim: true },

    // The raw callback, kept verbatim for reconciliation with the gateway's
    // own dashboard when a customer disputes a charge.
    gatewayPayload: { type: Schema.Types.Mixed, select: false },

    paidAt: { type: Date },
    refundedAt: { type: Date },
  },
  { timestamps: true }
);

paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });

export const Payment = mongoose.model("Payment", paymentSchema);
