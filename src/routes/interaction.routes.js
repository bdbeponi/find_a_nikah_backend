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
  passMember,
  unpassMember,
  getPassedMembers,
} from "../controllers/interaction.controllers.js";

/**
 * Five routers, not one mounted at the version root.
 *
 * `router.use(verifyJWT)` guards everything that reaches that router.
 */
export const likeRouter = Router();
likeRouter.use(verifyJWT);
// Named routes first: /likes/received would otherwise be read as a user id
likeRouter.route("/received").get(getLikesReceived);
likeRouter.route("/sent").get(getLikesSent);
likeRouter.route("/:userId").post(likeMember).delete(unlikeMember);

export const passRouter = Router();
passRouter.use(verifyJWT);
passRouter.route("/").get(getPassedMembers);
passRouter.route("/:userId").post(passMember).delete(unpassMember);

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
