import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  listNotifications,
  getUnreadCount,
  markOneRead,
  markAllRead,
  removeNotification,
} from "../controllers/notification.controllers.js";

const router = Router();

router.use(verifyJWT);

router.route("/").get(listNotifications);

// Both named routes go before /:id
router.route("/unread-count").get(getUnreadCount);
router.route("/read-all").patch(markAllRead);

router.route("/:id").delete(removeNotification);
router.route("/:id/read").patch(markOneRead);

export default router;
