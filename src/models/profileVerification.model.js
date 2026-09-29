import mongoose, { Schema } from "mongoose";
import { VERIFICATION_DOC_TYPES, VERIFICATION_STATUSES } from "../constants.js";

/**
 * A member's request to be verified, and the moderator's answer.
 *
 * Separate from User.isVerified: that is the *result*, read on every search.
 * This is the paperwork, read only by the member and the moderation queue, and
 * it holds an identity document - so it never travels with a profile response.
 */
const profileVerificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    documentType: {
      type: String,
      enum: VERIFICATION_DOC_TYPES,
      required: true,
    },
    // A scan of a national ID. Private storage, never the public bucket, and
    // never returned to anybody but the owner and a moderator.
    documentUrl: { type: String, required: true },
    documentStorageKey: { type: String },

    status: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: "pending",
    },
    rejectionReason: { type: String, trim: true },

    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// The admin queue: oldest pending first, so nobody waits forever
profileVerificationSchema.index({ status: 1, createdAt: 1 });
profileVerificationSchema.index({ userId: 1, createdAt: -1 });

// One open request at a time. A member spamming the queue with ten copies is
// the moderator's problem otherwise, and a partial index keeps the resolved
// history intact.
profileVerificationSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export const ProfileVerification = mongoose.model(
  "ProfileVerification",
  profileVerificationSchema
);
