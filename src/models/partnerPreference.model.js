import mongoose, { Schema } from "mongoose";
import {
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  MARITAL_STATUSES,
  MAX_AGE,
  MIN_AGE,
  RELIGIONS,
  RELIGIOUSNESS,
  FAITH,
} from "../constants.js";

/**
 * What the member is looking for. One per user, read on every recommendation.
 *
 * Every list field is "empty means no preference", not "empty means match
 * nothing" - a new member with a blank preference should see everybody, not an
 * empty result. matching.service.js only adds a clause for a field that has
 * entries.
 */
const range = (min, max) => ({
  min: { type: Number, min, max },
  max: { type: Number, min, max },
});

const partnerPreferenceSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    ageRange: range(MIN_AGE, MAX_AGE),
    heightRange: range(HEIGHT_CM_MIN, HEIGHT_CM_MAX),

    preferredReligions: [{ type: String, enum: RELIGIONS }],
    preferredSects: [{ type: String, enum: FAITH }],
    preferredReligiousness: [{ type: String, enum: RELIGIOUSNESS }],
    maritalStatuses: [{ type: String, enum: MARITAL_STATUSES }],

    preferredCities: [{ type: String, trim: true }],
    preferredCountries: [{ type: String, trim: true }],

    // Free text on purpose: an enum of every degree in the country would be
    // out of date the week it shipped.
    preferredEducation: [{ type: String, trim: true }],
    preferredOccupations: [{ type: String, trim: true }],

    minMonthlyIncome: { type: Number, min: 0 },

    willingToRelocate: { type: Boolean, default: false },
    // The member wants only moderator-verified people in their results
    verifiedOnly: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// A min above a max returns nothing and looks like a broken search rather than
// a bad input, so it is refused at the boundary.
partnerPreferenceSchema.pre("validate", function (next) {
  for (const field of ["ageRange", "heightRange"]) {
    const value = this[field];
    if (value?.min != null && value?.max != null && value.min > value.max) {
      return next(new Error(`${field}: min cannot be greater than max`));
    }
  }
  next();
});

export const PartnerPreference = mongoose.model(
  "PartnerPreference",
  partnerPreferenceSchema
);
