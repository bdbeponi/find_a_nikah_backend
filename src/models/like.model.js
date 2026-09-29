import mongoose, { Schema } from "mongoose";
import { LIKE_STATUSES } from "../constants.js";

const likeSchema = new Schema(
  {
    fromUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    toUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: LIKE_STATUSES,
      default: "pending",
    },
  },
  { timestamps: true }
);

/**
 * One like per direction, enforced by the database.
 *
 * The controller checks first, but two taps on a slow connection arrive as two
 * requests that both pass the check. Only a unique index actually prevents the
 * duplicate - the controller then just turns the E11000 into a friendly reply.
 */
likeSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

// "who liked me", newest first
likeSchema.index({ toUserId: 1, status: 1, createdAt: -1 });
// "who I liked", and the exclusion list the recommender needs
likeSchema.index({ fromUserId: 1, createdAt: -1 });

export const Like = mongoose.model("Like", likeSchema);
