import mongoose, { Schema } from "mongoose";
import { slugify } from "../utils/slugify.js";

/**
 * The catalogue. Public, read constantly, written almost never.
 *
 * Price is in the smallest unit (poisha for BDT) and stored as an integer.
 * Floating point money is how 299.99 becomes 299.98999999999995 in a receipt.
 */
const subscriptionPlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 1000 },

    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "BDT", uppercase: true, maxlength: 3 },

    durationDays: { type: Number, required: true, min: 1 },

    // What the plan actually unlocks. Read by the entitlement checks.
    features: {
      maxLikesPerDay: { type: Number, default: 10 },
      canMessageBeforeMatch: { type: Boolean, default: false },
      canSeeWhoLikedMe: { type: Boolean, default: false },
      canSeeContactDetails: { type: Boolean, default: false },
      boostedInSearch: { type: Boolean, default: false },
    },

    isActive: { type: Boolean, default: true },
    serial: { type: Number, default: 0 },
  },
  { timestamps: true }
);

subscriptionPlanSchema.index({ isActive: 1, serial: 1 });

subscriptionPlanSchema.pre("save", function (next) {
  if (this.isModified("name") && !this.slug) this.slug = slugify(this.name);
  next();
});

export const SubscriptionPlan = mongoose.model(
  "SubscriptionPlan",
  subscriptionPlanSchema
);
