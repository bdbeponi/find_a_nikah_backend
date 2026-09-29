import mongoose, { Schema } from "mongoose";

/**
 * "Who viewed my profile".
 *
 * One row per viewer per owner, not one per view: scrolling back and forth
 * through the same profile would otherwise write a row a second, and the
 * feature only ever shows the latest visit anyway. The view endpoint upserts
 * on the pair and bumps viewedAt.
 */
const profileViewSchema = new Schema(
  {
    viewerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    profileOwnerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    viewedAt: { type: Date, default: Date.now },
    viewCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);

profileViewSchema.index({ viewerId: 1, profileOwnerId: 1 }, { unique: true });
// The list the owner sees
profileViewSchema.index({ profileOwnerId: 1, viewedAt: -1 });

// Six months is well past useful for this
profileViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const ProfileView = mongoose.model("ProfileView", profileViewSchema);
