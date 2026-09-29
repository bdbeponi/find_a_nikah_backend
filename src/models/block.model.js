import mongoose, { Schema } from "mongoose";

/**
 * Directional, unlike Match: A blocking B is one row, and B has no say in it.
 *
 * Both directions still have to be excluded from every search - being blocked
 * hides you from them, and blocking them hides them from you - which is what
 * getBlockedUserIds() in block.service.js returns.
 */
const blockSchema = new Schema(
  {
    blockerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    blockedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

blockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });
// Read on every single search, in both directions
blockSchema.index({ blockedUserId: 1 });

export const Block = mongoose.model("Block", blockSchema);
