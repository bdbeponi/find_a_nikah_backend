import mongoose, { Schema } from "mongoose";
import { NOTIFICATION_TYPES } from "../constants.js";

const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 1000 },

    // Whatever the client needs to deep-link: a matchId, a conversationId.
    // Loose on purpose - every notification type carries something different,
    // and a schema per type would be twelve schemas.
    data: { type: Schema.Types.Mixed },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true }
);

// The list, and the unread badge, in one index
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

/**
 * Notifications are noise after a while, and nobody scrolls back 90 days.
 * Mongo deletes them on its own rather than needing a cron job that will one
 * day stop running.
 */
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Notification = mongoose.model("Notification", notificationSchema);
