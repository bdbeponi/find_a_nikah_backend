import mongoose, { Schema } from "mongoose";

/**
 * When a user swipes left or passes on viewing a profile.
 *
 * Stored so passed profiles are excluded from the main discovery deck,
 * but can be revisited in the "Second Look" feed (especially when the passed user
 * has liked the passer).
 */
const passSchema = new Schema(
  {
    passerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    passedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// One pass per direction, unique
passSchema.index({ passerId: 1, passedUserId: 1 }, { unique: true });
// "Profiles I passed on", sorted newest first for Second Look
passSchema.index({ passerId: 1, createdAt: -1 });
// "Who passed on me", if needed for analytics
passSchema.index({ passedUserId: 1, createdAt: -1 });

export const Pass = mongoose.model("Pass", passSchema);
