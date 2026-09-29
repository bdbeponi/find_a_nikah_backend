import mongoose, { Schema } from "mongoose";

/**
 * One row per issued refresh token, so tokens can be rotated and revoked.
 *
 * This replaces the single `refreshToken` string that used to sit on the user.
 * That version could only ever hold one session, so signing in on a phone
 * silently signed you out on a laptop, and there was no way to revoke one
 * device without revoking all of them.
 *
 * Stored as a SHA-256 hash, not the token. A refresh token is a long-lived
 * credential - a leaked database dump full of live ones is every account on
 * the site. Lookup hashes the incoming token and matches on that.
 *
 * Rotation: each use revokes the old row and records the new one in
 * replacedBy. If a revoked token is ever presented again it has been stolen -
 * the whole chain is then killed, which is what detectReuse does in
 * auth.service.js.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    tokenHash: { type: String, required: true, unique: true },

    expiresAt: { type: Date, required: true },

    revokedAt: { type: Date },
    replacedBy: { type: String },

    // Enough to show the member a "signed in on" list and to spot a session
    // from somewhere they have never been.
    userAgent: { type: String, maxlength: 400 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

// "every session for this member", for a log-out-everywhere
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });

// Expired rows are useless; Mongo removes them itself.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.methods.isUsable = function () {
  return !this.revokedAt && this.expiresAt > new Date();
};

export const RefreshToken = mongoose.model("RefreshToken", refreshTokenSchema);
