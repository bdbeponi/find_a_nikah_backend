import { Router } from "express";
import {
  verifyJWT,
  isAdmin,
  authorizeRoles,
} from "../middlewares/auth.middlewares.js";
import { ROLES } from "../constants.js";

import {
  getDashboard,
  getMembers,
  getMember,
  setMemberStatus,
  setMemberVerification,
  signOutMember,
  getStaff,
  createStaff,
  setStaffRole,
  setStaffStatus,
} from "../controllers/admin.controllers.js";

import {
  listProfiles,
  getProfile,
  setProfileStatus,
  listReports,
  getReport,
  resolveReport,
  listVerifications,
  reviewVerification,
  listAuditLog,
} from "../controllers/adminModeration.controllers.js";

import {
  listPhotos,
  reviewPhoto,
  listPlansAdmin,
  createPlan,
  updatePlan,
  retirePlan,
  listPayments,
  refundPayment,
  listSubscriptions,
  updateSubscription,
  grantSubscription,
  broadcast,
} from "../controllers/adminContent.controllers.js";

const router = Router();

// Applied once to the whole router rather than per route: a new admin endpoint
// added below cannot forget its guard, which is the only way this kind of leak
// ever happens. The staff routes narrow it further to super_admin, inside the
// controller via checkStaffMutation.
router.use(verifyJWT, isAdmin);

router.route("/dashboard").get(getDashboard);

// Accounts
router.route("/users").get(getMembers);
router.route("/users/:id").get(getMember);
router.route("/users/:id/status").patch(setMemberStatus);
router.route("/users/:id/verify").patch(setMemberVerification);
// Ends every session without touching the account - the answer to "somebody
// else is in my account", which a suspension would answer far too harshly.
router.route("/users/:id/sign-out").post(signOutMember);

// Moderation queues
router.route("/profiles").get(listProfiles);
router.route("/profiles/:id").get(getProfile);
router.route("/profiles/:id/status").patch(setProfileStatus);

router.route("/reports").get(listReports);
router.route("/reports/:id").get(getReport);
router.route("/reports/:id").patch(resolveReport);

router.route("/verifications").get(listVerifications);
router.route("/verifications/:id").patch(reviewVerification);

router.route("/photos").get(listPhotos);
router.route("/photos/:id").patch(reviewPhoto);

/**
 * Money.
 *
 * Narrower than the rest of this router: a moderator reviews profiles, they do
 * not set prices or hand out subscriptions. The read-only lists stay open to
 * them because support questions land there first.
 */
const canBill = authorizeRoles(ROLES.SUPER_ADMIN, ROLES.ADMIN);

router.route("/plans").get(listPlansAdmin).post(canBill, createPlan);
router.route("/plans/:id").patch(canBill, updatePlan).delete(canBill, retirePlan);

router.route("/payments").get(listPayments);
router.route("/payments/:id/refund").patch(canBill, refundPayment);
router
  .route("/subscriptions")
  .get(listSubscriptions)
  .post(canBill, grantSubscription);
router.route("/subscriptions/:id").patch(canBill, updateSubscription);

// An announcement to every member at once. Admin and above: a badly worded
// one cannot be unsent.
router.route("/notifications").post(canBill, broadcast);

// Read-only history of everything above
router.route("/audit-log").get(listAuditLog);

// Team
router.route("/staff").get(getStaff).post(createStaff);
router.route("/staff/:id/role").patch(setStaffRole);
router.route("/staff/:id/status").patch(setStaffStatus);

export default router;
