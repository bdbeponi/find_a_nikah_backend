import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { upload } from "../middlewares/multer.middlewares.js";
import {
  listConversations,
  openConversation,
  listMessages,
  sendMessage,
  markRead,
  setArchived,
  deleteMessage,
  getUnreadCount,
} from "../controllers/chat.controllers.js";

// One router per prefix - see the note in interaction.routes.js for why these
// are not a single router mounted at the version root.

export const conversationRouter = Router();
conversationRouter.use(verifyJWT);

conversationRouter.route("/").get(listConversations);
conversationRouter.route("/:userId").post(openConversation);

conversationRouter
  .route("/:id/messages")
  .get(listMessages)
  .post(upload.single("image"), sendMessage);

conversationRouter.route("/:id/read").patch(markRead);
conversationRouter.route("/:id/archive").patch(setArchived);

export const messageRouter = Router();
messageRouter.use(verifyJWT);

// Before /:id, or "unread-count" is read as a message id
messageRouter.route("/unread-count").get(getUnreadCount);
messageRouter.route("/:id").delete(deleteMessage);
