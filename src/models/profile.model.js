import mongoose, { Schema } from "mongoose";
import {
  ACCOUNT_TYPES,
  ALCOHOL_HABITS,
  BORN_MUSLIM_STATUS,
  CHILDREN_STATUS,
  GENDERS,
  HALAL_FOOD_HABITS,
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  KNOW_DURATIONS,
  LOCATION_RADIUS_OPTIONS,
  MARITAL_STATUSES,
  MARRIAGE_TIMELINES,
  ONBOARDING_INTENTS,
  PROFILE_FOR,
  PROFILE_STATUS,
  PROFILE_STATUSES,
  REFERRAL_SOURCES,
  RELIGIONS,
  RELIGIOUS_PRACTICES,
  RELIGIOUSNESS,
  RELOCATE_STATUS,
  SECTS,
  SMOKING_HABITS,
} from "../constants.js";

/**
 * The searchable half of a member. One per user.
 *
 * Two storage decisions drive everything downstream:
 *
 *   dateOfBirth, not age. An age is wrong the day after it is written, and a
 *   nightly job to re-stamp every row is a job that will one day not run. The
 *   search converts an age range into a dateOfBirth range instead, which is a
 *   plain indexed range query.
 *
 *   heightCm, not "5'6\"". Feet and inches is a display format; stored as text
 *   it makes a range query impossible.
 */
const profileSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // Individual or Family account
    accountType: {
      type: String,
      enum: { values: ACCOUNT_TYPES, message: "{VALUE} is not a valid account type" },
      default: "individual",
    },
    // Who the profile is created for
    profileFor: {
      type: String,
      enum: { values: PROFILE_FOR, message: "{VALUE} is not a valid relation" },

    },

    // Step 5: Intent
    intent: {
      type: String,
      enum: ONBOARDING_INTENTS,
    },
    // Step 6: Referral source
    referralSource: {
      type: String,
      enum: REFERRAL_SOURCES,
    },

    // Copied from the account because every search filters on it and a $lookup
    // into users on each query would cost more than the one field it saves.
    // Neither the account's gender nor this one is editable after signup.
    gender: {
      type: String,
      enum: { values: GENDERS, message: "{VALUE} is not a valid gender" },
      required: true,
    },

    dateOfBirth: { type: Date, required: true },

    // Step 7, 8, 9: Demographics
    nationality: { type: String, trim: true, default: "Bangladeshi" },
    grewUpIn: { type: String, trim: true },
    ethnicity: { type: String, trim: true },
    motherTongue: { type: String, trim: true },
    languages: [{ type: String, trim: true }],

    // Step 10: Height
    heightCm: { type: Number, min: HEIGHT_CM_MIN, max: HEIGHT_CM_MAX },

    // Step 11: Education Level
    educationLevel: { type: String, trim: true },

    // Step 12: Profession title
    professionTitle: { type: String, trim: true },

    // Step 13: Marital status
    maritalStatus: {
      type: String,
      enum: { values: MARITAL_STATUSES, message: "{VALUE} is not valid" },
      default: "never_married",
    },

    // Step 14: Intentions for marriage
    marriageIntentions: {
      getToknowDuration: { type: String, enum: KNOW_DURATIONS },
      marriageTimeline: { type: String, enum: MARRIAGE_TIMELINES },
    },

    // Step 15, 16: Faith & Religious practice
    religion: {
      type: String,
      enum: { values: RELIGIONS, message: "{VALUE} is not valid" },
      default: "islam",
    },
    sect: { type: String, enum: SECTS },
    religiousness: { type: String, enum: RELIGIOUSNESS },
    religiousPractice: { type: String, enum: RELIGIOUS_PRACTICES },

    // Step 17: Lifestyle
    lifestyle: {
      halalFood: { type: String, enum: HALAL_FOOD_HABITS, default: "always" },
      smoking: { type: String, enum: SMOKING_HABITS, default: "never" },
      alcohol: { type: String, enum: ALCOHOL_HABITS, default: "never" },
    },

    // Step 18: About you
    aboutYou: {
      bornMuslim: { type: String, enum: BORN_MUSLIM_STATUS, default: "born_muslim" },
      haveChildren: { type: String, enum: CHILDREN_STATUS, default: "no" },
      relocateAbroad: { type: String, enum: RELOCATE_STATUS, default: "maybe" },
    },

    // Step 19: Personality description
    personalityTraits: [{ type: String, trim: true }],

    // Step 20: Interests
    interests: {
      cultural: [{ type: String, trim: true }],
      fashion: [{ type: String, trim: true }],
      foodDrinks: [{ type: String, trim: true }],
      sports: [{ type: String, trim: true }],
      activities: [{ type: String, trim: true }],
    },

    // Step 21: Bio
    aboutMe: { type: String, trim: true, maxlength: 2000 },

    // Step 26: Location & Radius
    city: { type: String, trim: true, index: true },
    country: { type: String, trim: true, default: "Bangladesh" },
    locationRadius: {
      type: String,
      enum: LOCATION_RADIUS_OPTIONS,
      default: "large",
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: undefined,
      },
    },

    // Moderation & Onboarding Progress
    profileStatus: {
      type: String,
      enum: { values: PROFILE_STATUSES, message: "{VALUE} is not valid" },
      default: PROFILE_STATUS.PENDING,
    },
    rejectionReason: { type: String, trim: true },
    onboardingStep: { type: Number, default: 1 },
    isOnboardingCompleted: { type: Boolean, default: false },

    isDiscoverable: { type: Boolean, default: true },

    publishedAt: { type: Date },

    // 0-100, recomputed on save. Drives the "complete your profile" nudge and
    // the recommendation ranking.
    completeness: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true }
);

// --------------------------------------------------------------- indexes
// Mirrors the queries in search.service.js. Field order follows the equality
// -> sort -> range rule: an index whose sort key sits behind a range field
// cannot serve the sort, and Mongo silently does an in-memory sort instead.
profileSchema.index({
  gender: 1,
  profileStatus: 1,
  isDiscoverable: 1,
  publishedAt: -1,
});
profileSchema.index({ gender: 1, religion: 1, city: 1, profileStatus: 1 });
profileSchema.index({ city: 1, religion: 1, maritalStatus: 1 });
// Every search filters an age range, which is a dateOfBirth range
profileSchema.index({ profileStatus: 1, isDiscoverable: 1, dateOfBirth: 1 });
profileSchema.index({ location: "2dsphere" });
profileSchema.index({ aboutMe: "text" });

/** Age in whole years, derived. Never stored. */
profileSchema.virtual("age").get(function () {
  if (!this.dateOfBirth) return null;
  const now = new Date();
  let age = now.getFullYear() - this.dateOfBirth.getFullYear();
  const monthDiff = now.getMonth() - this.dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < this.dateOfBirth.getDate())) {
    age -= 1;
  }
  return age;
});

profileSchema.set("toJSON", { virtuals: true });
profileSchema.set("toObject", { virtuals: true });

/**
 * A half-empty Point breaks the 2dsphere index for the whole collection, so a
 * location with no coordinates is removed rather than saved.
 */
profileSchema.pre("save", function (next) {
  if (this.location && !this.location.coordinates?.length) {
    this.location = undefined;
  }
  next();
});

export const Profile = mongoose.model("Profile", profileSchema);
