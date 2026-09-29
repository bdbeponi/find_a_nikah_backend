import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  likeMember,
  unlikeMember,
  getLikesReceived,
  getLikesSent,
  getMatches,
  unmatch,
  getMatchConversation,
  blockMember,
  unblockMember,
  getBlocks,
  createReport,
  getMyReports,
} from "../controllers/interaction.controllers.js";

/**
 * Four routers, not one mounted at the version root.
 *
 * `router.use(verifyJWT)` guards everything that reaches that router - which,
 * for a router mounted at /api/v1, is every /api/v1 request, including the ones
 * meant for a different router mounted alongside it. That is how the public
 * pricing endpoint started answering 401: a guard three files away was running
 * first. A router per prefix keeps each `use` inside the paths it belongs to,
 * and keeps the property that matters - a route added below cannot forget its
 * guard.
 */
export const likeRouter = Router();
likeRouter.use(verifyJWT);
// Named routes first: /likes/received would otherwise be read as a user id
likeRouter.route("/received").get(getLikesReceived);
likeRouter.route("/sent").get(getLikesSent);
likeRouter.route("/:userId").post(likeMember).delete(unlikeMember);

export const matchRouter = Router();
matchRouter.use(verifyJWT);
matchRouter.route("/").get(getMatches);
matchRouter.route("/:id").delete(unmatch);
matchRouter.route("/:id/conversation").get(getMatchConversation);

export const blockRouter = Router();
blockRouter.use(verifyJWT);
blockRouter.route("/").get(getBlocks);
blockRouter.route("/:userId").post(blockMember).delete(unblockMember);

export const reportRouter = Router();
reportRouter.use(verifyJWT);
reportRouter.route("/").post(createReport);
reportRouter.route("/mine").get(getMyReports);
