import mongoose, { Schema } from "mongoose";
import {
  GENDERS,
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  MARITAL_STATUSES,
  PROFILE_STATUS,
  PROFILE_STATUSES,
  RELIGIONS,
  RELIGIOUSNESS,
  SECTS,
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


    // Copied from the account because every search filters on it and a $lookup
    // into users on each query would cost more than the one field it saves.
    // Neither the account's gender nor this one is editable after signup.
    gender: {
      type: String,
      enum: { values: GENDERS, message: "{VALUE} is not a valid gender" },
      required: true,
    },

    dateOfBirth: { type: Date, required: true },

    heightCm: { type: Number, min: HEIGHT_CM_MIN, max: HEIGHT_CM_MAX },

    maritalStatus: {
      type: String,
      enum: { values: MARITAL_STATUSES, message: "{VALUE} is not valid" },
      required: true,
    },

    religion: {
      type: String,
      enum: { values: RELIGIONS, message: "{VALUE} is not valid" },
      required: true,
    },
    sect: { type: String, enum: SECTS },
    religiousness: { type: String, enum: RELIGIOUSNESS },

    city: { type: String, trim: true, index: true },
    country: { type: String, trim: true, default: "Bangladesh" },

    // GeoJSON, for "near me". Optional - most members never set it, and an
    // empty object here would break the 2dsphere index, so the whole field is
    // left undefined rather than half-filled.
    location: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: {
        type: [Number], // [longitude, latitude] - in that order, GeoJSON's, not Google's
      },
    },

    aboutMe: { type: String, trim: true, maxlength: 2000 },

    motherTongue: { type: String, trim: true },
    nationality: { type: String, trim: true, default: "Bangladeshi" },

    profileStatus: {
      type: String,
      enum: { values: PROFILE_STATUSES, message: "{VALUE} is not valid" },
      default: PROFILE_STATUS.PENDING,
    },
    rejectionReason: { type: String, trim: true },

    /**
     * The member's own switch. Separate from profileStatus on purpose:
     * profileStatus is what the moderator decided, isDiscoverable is what the
     * member wants. A member pausing their search must not look, to an admin,
     * like a profile that was rejected.
     *
     * false hides them from search, recommendations and matching. It does not
     * delete anything - they keep their profile, their matches and their
     * conversations.
     */
    isDiscoverable: { type: Boolean, default: true },

    // Set the first time a moderator publishes it, and never moved again, so
    // "newest published" is stable.
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
