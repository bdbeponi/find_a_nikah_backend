import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  getMe,
  updateMe,
  deleteMe,
  changePassword,
  getSessions,
  revokeSession,
} from "../controllers/user.controllers.js";

const router = Router();

// Nothing here is reachable without a session
router.use(verifyJWT);

router.route("/me").get(getMe).patch(updateMe).delete(deleteMe);
router.route("/me/password").patch(changePassword);

// Where this account is signed in, and how to end one of them. `auth/logout-all`
// ends every device at once; this is the per-device version.
router.route("/me/sessions").get(getSessions);
router.route("/me/sessions/:id").delete(revokeSession);

export default router;
