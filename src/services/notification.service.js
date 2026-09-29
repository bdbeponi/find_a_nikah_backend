import { Notification } from "../models/notification.model.js";
import { emitToUser } from "../socket/emit.js";

/**
 * Writes a notification and pushes it to whoever is connected.
 *
 * Never throws, for the same reason recordAudit does not: this is always the
 * last step of something that already happened. A match that is made and then
 * answers 500 because the notification insert failed would be retried by the
 * client, and the second attempt tells the member their match failed when it
 * did not.
 */
export const notify = async ({ userId, type, title, body, data }) => {
  try {
    const notification = await Notification.create({
      userId,
      type,
      title,
      body,
      data,
    });

    emitToUser(userId, "notification:new", notification);
    return notification;
  } catch (err) {
    console.error(`⚠️  notification (${type}) failed for ${userId} -`, err.message);
    return null;
  }
};
