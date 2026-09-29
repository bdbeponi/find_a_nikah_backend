import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  searchProfiles,
  getRecommendations,
  getPublicProfile,
  getMyViewers,
  getMyViewed,
  clearMyViewed,
} from "../controllers/discovery.controllers.js";

const router = Router();

// Browsing needs a session: every result is filtered by who is asking - their
// gender, their blocks, their matches - and there is no sensible answer for a
// caller with none of those.
router.use(verifyJWT);

router.route("/search").get(searchProfiles);
router.route("/recommendations").get(getRecommendations);

// Before /:userId, or "me" is read as an id and answers 404 for everyone
router.route("/me/viewers").get(getMyViewers);
router.route("/me/viewed").get(getMyViewed).delete(clearMyViewed);

router.route("/:userId").get(getPublicProfile);

export default router;
