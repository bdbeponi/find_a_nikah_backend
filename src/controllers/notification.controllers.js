import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { Notification } from "../models/notification.model.js";
import { buildPaginationMeta, getPagination } from "../utils/pagination.js";
import { NOTIFICATION_TYPES } from "../constants.js";

/** GET /api/v1/notifications */
const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = { userId: req.user._id };
  if (req.query.unread === "true") filter.isRead = false;
  if (NOTIFICATION_TYPES.includes(req.query.type)) filter.type = req.query.type;

  const [notifications, totalCount, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: req.user._id, isRead: false }),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        notifications,
        unreadCount,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "Notifications"
    )
  );
});

/** GET /api/v1/notifications/unread-count - the badge, on every app open. */
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({
    userId: req.user._id,
    isRead: false,
  });

  return res.status(200).json(new ApiResponse(200, { count }, "Unread"));
});

/** PATCH /api/v1/notifications/:id/read */
const markOneRead = asyncHandler(async (req, res) => {
  // userId in the filter, so this cannot be pointed at somebody else's row
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { $set: { isRead: true, readAt: new Date() } },
    { new: true }
  );

  if (!notification) throw new ApiError(404, "Notification not found");

  return res.status(200).json(new ApiResponse(200, notification, "Marked as read"));
});

/** PATCH /api/v1/notifications/read-all */
const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { userId: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, { marked: result.modifiedCount }, "All marked as read"));
});

/** DELETE /api/v1/notifications/:id */
const removeNotification = asyncHandler(async (req, res) => {
  const removed = await Notification.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!removed) throw new ApiError(404, "Notification not found");

  return res.status(200).json(new ApiResponse(200, null, "Removed"));
});

export {
  listNotifications,
  getUnreadCount,
  markOneRead,
  markAllRead,
  removeNotification,
};
