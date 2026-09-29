import mongoose, { Schema } from "mongoose";
import { OTP_MAX_ATTEMPTS, OTP_PURPOSES } from "../constants.js";

/**
 * A one-time code, stored hashed.
 *
 * Hashed because a six-digit code is a credential: anyone who can read the
 * database - a backup, a log, an aggregation dump - could otherwise complete a
 * password reset for any account with an open code. Verification compares
 * hashes, exactly as it does for a password.
 */
const otpVerificationSchema = new Schema(
  {
    // Phone or email, whichever the code was sent to. Not a userId: a reset
    // can be requested before we know who is asking.
    identifier: { type: String, required: true, trim: true, lowercase: true },

    // A code issued to confirm a phone must never be accepted to reset a
    // password, so the purpose is part of the lookup, not just a label.
    purpose: { type: String, enum: OTP_PURPOSES, required: true },

    codeHash: { type: String, required: true, select: false },

    expiresAt: { type: Date, required: true },

    // Brute force on six digits is a million guesses; without a cap it is a
    // minute's work.
    attempts: { type: Number, default: 0, max: OTP_MAX_ATTEMPTS },

    // Set the moment it is accepted, so the same code cannot be used twice
    consumedAt: { type: Date },
  },
  { timestamps: true }
);

// The verify lookup: newest unconsumed code for this identifier and purpose
otpVerificationSchema.index({ identifier: 1, purpose: 1, createdAt: -1 });

// Mongo clears them out once they expire, so the collection cannot grow
// forever and an old code cannot linger to be guessed.
otpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

otpVerificationSchema.methods.isUsable = function () {
  return (
    !this.consumedAt &&
    this.expiresAt > new Date() &&
    this.attempts < OTP_MAX_ATTEMPTS
  );
};

export const OtpVerification = mongoose.model(
  "OtpVerification",
  otpVerificationSchema
);
