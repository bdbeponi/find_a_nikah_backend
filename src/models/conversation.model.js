import mongoose, { Schema } from "mongoose";

/**
 * One per match. Two people, never a group.
 *
 * lastMessageAt and lastMessagePreview are denormalised onto this document on
 * purpose: the conversation list is the most-opened screen in the app, and
 * without them it is one query for the list plus one per row to find the
 * latest message. They are written by message.service.js in the same operation
 * that inserts the message.
 */
const conversationSchema = new Schema(
  {
    participants: [
      { type: Schema.Types.ObjectId, ref: "User", required: true },
    ],
    matchId: { type: Schema.Types.ObjectId, ref: "Match", unique: true, sparse: true },

    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, maxlength: 200 },
    lastMessageSender: { type: Schema.Types.ObjectId, ref: "User" },

    /**
     * Archiving is per person, which is why this is a list rather than a flag.
     * One side clearing their inbox must not remove the thread from the other
     * side's, and the messages themselves are never deleted.
     */
    archivedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],

    // Unread counts, keyed by user id. A Map rather than two named fields so
    // the shape does not assume which participant is which.
    unread: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },
  },
  { timestamps: true }
);

// The conversation list, exactly as the API sorts it
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model("Conversation", conversationSchema);
