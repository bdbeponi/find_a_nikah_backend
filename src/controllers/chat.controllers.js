import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Match } from "../models/match.model.js";
import { isBlockedBetween } from "../services/block.service.js";
import { getEntitlements } from "../services/entitlement.service.js";
import { notify } from "../services/notification.service.js";
import { emitToUser } from "../socket/emit.js";
import { buildPaginationMeta, getPagination } from "../utils/pagination.js";
import { UPLOAD_DIR } from "../constants.js";

// Long enough to tell one thread from another in a list, short enough that a
// 5000-character message does not become a 5000-character row on the inbox.
const PREVIEW_LENGTH = 120;

export const previewOf = (message) => {
  if (message.messageType === "image") return "📷 Photo";
  return String(message.text || "").slice(0, PREVIEW_LENGTH);
};

/** The conversation, if this member is in it. Ownership lives in the filter. */
const ownedConversation = async (id, userId) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, "Conversation not found");

  const conversation = await Conversation.findOne({
    _id: id,
    participants: userId,
  });

  if (!conversation) throw new ApiError(404, "Conversation not found");
  return conversation;
};

const otherParticipant = (conversation, userId) =>
  conversation.participants.find((one) => String(one) !== String(userId));

/**
 * GET /api/v1/conversations
 *
 * Sorted by lastMessageAt, which is on the conversation itself - see the note
 * on the schema. Without it this is one query plus one per row.
 */
const listConversations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = { participants: req.user._id };
  // Archiving is per person: the other side's inbox is untouched.
  filter.archivedBy = req.query.archived === "true"
    ? req.user._id
    : { $ne: req.user._id };

  const [conversations, totalCount] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("participants", "fullName isVerified lastActiveAt")
      .lean(),
    Conversation.countDocuments(filter),
  ]);

  const rows = conversations.map((conversation) => ({
    ...conversation,
    partner: conversation.participants.find(
      (one) => String(one._id) !== String(req.user._id)
    ),
    // A lean() Map comes back as a plain object, so this reads the same either way
    unreadCount: conversation.unread?.[String(req.user._id)] || 0,
  }));

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { conversations: rows, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Your conversations"
      )
    );
});

/**
 * POST /api/v1/conversations/:userId - open a thread with somebody.
 *
 * A match already has one, made with the match itself. This is the paid
 * "message first" route, and it is gated: without the entitlement, the only way
 * to a conversation is for both people to have said yes.
 */
const openConversation = asyncHandler(async (req, res) => {
  const targetId = req.params.userId;

  if (String(targetId) === String(req.user._id)) {
    throw new ApiError(400, "That is you");
  }

  if (await isBlockedBetween(req.user._id, targetId)) {
    throw new ApiError(404, "Member not found");
  }

  const match = await Match.findOne({
    users: { $all: [req.user._id, targetId] },
    status: "active",
  });

  if (match?.conversationId) {
    const existing = await Conversation.findById(match.conversationId);
    if (existing) {
      return res.status(200).json(new ApiResponse(200, existing, "Conversation"));
    }
  }

  if (!match) {
    const entitlements = await getEntitlements(req.user._id);
    if (!entitlements.canMessageBeforeMatch) {
      throw new ApiError(
        403,
        "You can message them once you have matched. Upgrade to message first."
      );
    }
  }

  const existing = await Conversation.findOne({
    participants: { $all: [req.user._id, targetId], $size: 2 },
  });

  if (existing) {
    return res.status(200).json(new ApiResponse(200, existing, "Conversation"));
  }

  const conversation = await Conversation.create({
    participants: [req.user._id, targetId],
    matchId: match?._id,
  });

  return res.status(201).json(new ApiResponse(201, conversation, "Conversation opened"));
});

/**
 * GET /api/v1/conversations/:id/messages
 *
 * Cursor paging on _id, not skip/limit. A long thread makes `skip: 5000` walk
 * five thousand documents on every scroll; `_id < cursor` on the existing index
 * is a seek. Newest first, because that is the screen the client opens on.
 */
const listMessages = asyncHandler(async (req, res) => {
  const conversation = await ownedConversation(req.params.id, req.user._id);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

  const filter = { conversationId: conversation._id };
  if (req.query.before && mongoose.isValidObjectId(req.query.before)) {
    filter._id = { $lt: new mongoose.Types.ObjectId(String(req.query.before)) };
  }

  const messages = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  // A sender-side delete blanks the body and keeps the row: the other person
  // still has their copy, and a missing row would renumber their thread.
  const cleaned = messages.map((message) =>
    message.deletedBy?.some((one) => String(one) === String(req.user._id))
      ? { ...message, text: "", attachmentUrl: null, deletedForMe: true }
      : message
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        messages: cleaned,
        hasMore,
        nextCursor: hasMore ? messages[messages.length - 1]?._id : null,
      },
      "Messages"
    )
  );
});

/**
 * POST /api/v1/conversations/:id/messages
 *
 * Order, with no transaction available:
 *   1. insert the message      - the fact, and the only irreplaceable write
 *   2. bump the conversation   - preview, timestamp, unread counter
 *   3. notify and emit         - never throws
 *
 * A crash after step 1 leaves the inbox preview a message behind; the message
 * itself is in the thread and the next one fixes the preview. The other order
 * would show a preview of a message that was never stored.
 */
const sendMessage = asyncHandler(async (req, res) => {
  const conversation = await ownedConversation(req.params.id, req.user._id);
  const receiverId = otherParticipant(conversation, req.user._id);

  if (await isBlockedBetween(req.user._id, receiverId)) {
    throw new ApiError(403, "You cannot message this member");
  }

  // An unmatched thread stays readable - the history is theirs - but it is
  // closed to new messages, which is what unmatching was for.
  if (conversation.matchId) {
    const match = await Match.findById(conversation.matchId).select("status").lean();
    if (match && match.status !== "active") {
      throw new ApiError(403, "This match has ended");
    }
  }

  const messageType = req.file ? "image" : "text";

  const message = await Message.create({
    conversationId: conversation._id,
    senderId: req.user._id,
    receiverId,
    messageType,
    text: req.body?.text,
    attachmentUrl: req.file ? `${UPLOAD_DIR}/${req.file.filename}` : undefined,
    attachmentStorageKey: req.file?.filename,
  });

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: message.createdAt,
        lastMessagePreview: previewOf(message),
        lastMessageSender: req.user._id,
      },
      $inc: { [`unread.${receiverId}`]: 1 },
      // A new message pulls the thread back out of the receiver's archive
      $pull: { archivedBy: receiverId },
    }
  );

  emitToUser(receiverId, "message:new", message);

  await notify({
    userId: receiverId,
    type: "message_received",
    title: req.user.fullName,
    body: previewOf(message),
    data: { conversationId: conversation._id, messageId: message._id },
  });

  return res.status(201).json(new ApiResponse(201, message, "Sent"));
});

/** PATCH /api/v1/conversations/:id/read */
const markRead = asyncHandler(async (req, res) => {
  const conversation = await ownedConversation(req.params.id, req.user._id);

  const result = await Message.updateMany(
    { conversationId: conversation._id, receiverId: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { [`unread.${req.user._id}`]: 0 } }
  );

  emitToUser(otherParticipant(conversation, req.user._id), "message:read", {
    conversationId: conversation._id,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { marked: result.modifiedCount }, "Marked as read"));
});

/** PATCH /api/v1/conversations/:id/archive - this member's inbox only. */
const setArchived = asyncHandler(async (req, res) => {
  const conversation = await ownedConversation(req.params.id, req.user._id);
  const archived = req.body?.archived !== false;

  await Conversation.updateOne(
    { _id: conversation._id },
    archived
      ? { $addToSet: { archivedBy: req.user._id } }
      : { $pull: { archivedBy: req.user._id } }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, null, archived ? "Archived" : "Restored"));
});

/** DELETE /api/v1/messages/:id - for me, never for them. */
const deleteMessage = asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id);

  if (
    !message ||
    ![message.senderId, message.receiverId].some(
      (one) => String(one) === String(req.user._id)
    )
  ) {
    throw new ApiError(404, "Message not found");
  }

  await Message.updateOne(
    { _id: message._id },
    { $addToSet: { deletedBy: req.user._id } }
  );

  return res.status(200).json(new ApiResponse(200, null, "Removed from your view"));
});

/** GET /api/v1/messages/unread-count - the badge. */
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Message.countDocuments({
    receiverId: req.user._id,
    isRead: false,
  });

  return res.status(200).json(new ApiResponse(200, { count }, "Unread messages"));
});

export {
  listConversations,
  openConversation,
  listMessages,
  sendMessage,
  markRead,
  setArchived,
  deleteMessage,
  getUnreadCount,
};
