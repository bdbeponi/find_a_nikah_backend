import mongoose, { Schema } from "mongoose";
import { MESSAGE_TYPES } from "../constants.js";

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Stored rather than derived from the conversation, so "my unread messages"
    // across every thread is one indexed query instead of a fan-out.
    receiverId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    messageType: { type: String, enum: MESSAGE_TYPES, default: "text" },
    text: { type: String, trim: true, maxlength: 5000 },
    attachmentUrl: { type: String },
    attachmentStorageKey: { type: String },

    isRead: { type: Boolean, default: false },
    readAt: { type: Date },

    // Sender-side delete. The other person keeps their copy, so the row stays
    // and only the body is blanked on read.
    deletedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

/**
 * The page query, and the reason messages use a cursor rather than skip/limit:
 * a long conversation would make `skip: 5000` walk five thousand documents on
 * every scroll. `_id` descending after this index is a seek, not a scan.
 */
messageSchema.index({ conversationId: 1, createdAt: -1 });
// Unread badge across all threads
messageSchema.index({ receiverId: 1, isRead: 1, createdAt: -1 });

// A text message with no text is a bug somewhere upstream; better to refuse it
// than to render an empty bubble.
messageSchema.pre("validate", function (next) {
  if (this.messageType === "text" && !this.text?.trim()) {
    return next(new Error("A text message cannot be empty"));
  }
  if (this.messageType === "image" && !this.attachmentUrl) {
    return next(new Error("An image message needs an attachment"));
  }
  next();
});

export const Message = mongoose.model("Message", messageSchema);
