import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { getPagination, buildPaginationMeta } from "../utils/pagination.js";
import { searchRegex } from "../utils/search.js";
import { requireString } from "../utils/requireString.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { Report } from "../models/report.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { Payment } from "../models/payment.model.js";
import { Subscription } from "../models/subscription.model.js";
import { Block } from "../models/block.model.js";
import { RefreshToken } from "../models/refreshToken.model.js";
import { revokeAllForUser } from "../services/auth.service.js";
import { recordAudit } from "../services/audit.service.js";
import {
  ACCOUNT_STATUS,
  ADMIN_ROLES,
  GENDERS,
  PROFILE_STATUS,
  ROLES,
} from "../constants.js";

/**
 * Turns the admin list query string into a mongo filter.
 *
 * Pure and exported so the check script can assert on it - this is the one
 * piece of real logic in this file, and the failure mode is silent: a filter
 * that quietly ignores `verified=false` shows the moderator an empty queue and
 * nothing looks broken.
 *
 * Only whitelisted values are read. `role` in particular is never taken
 * verbatim: `?role=super_admin` from a staff account would otherwise let them
 * enumerate the owners.
 */
export const buildMemberFilter = (query = {}) => {
  // Members only. Admins manage each other through a different screen, and
  // leaking the admin list into the member browser is how a staff account
  // finds out who to phish.
  const filter = { role: ROLES.MEMBER };

  // One box, both fields: an admin looking for somebody has either their name
  // or their number, and does not want to pick which first.
  const term = searchRegex(query.search);
  if (term) {
    filter.$or = [{ fullName: term }, { phone: term }];
  }

  if (GENDERS.includes(query.gender)) {
    filter.gender = query.gender;
  }

  // "false" has to be checked explicitly - `Boolean("false")` is true, which is
  // how a pending-verification queue ends up showing verified accounts.
  if (query.verified === "true" || query.verified === "false") {
    filter.isVerified = query.verified === "true";
  }

  // "not active" covers suspended AND deleted. Matching only "suspended" would
  // quietly hide closed accounts from the one screen an admin would look for
  // them on.
  if (query.active === "true" || query.active === "false") {
    filter.accountStatus =
      query.active === "true"
        ? ACCOUNT_STATUS.ACTIVE
        : { $ne: ACCOUNT_STATUS.ACTIVE };
  }

  return filter;
};

const getDashboard = asyncHandler(async (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // One round trip rather than six. Six countDocuments calls would each scan
  // the same collection to answer a question this one pass already answers.
  const [counts] = await User.aggregate([
    { $match: { role: ROLES.MEMBER } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        male: { $sum: { $cond: [{ $eq: ["$gender", "male"] }, 1, 0] } },
        female: { $sum: { $cond: [{ $eq: ["$gender", "female"] }, 1, 0] } },
        verified: { $sum: { $cond: ["$isVerified", 1, 0] } },
        disabled: {
          $sum: { $cond: [{ $eq: ["$accountStatus", "active"] }, 0, 1] },
        },
        newThisWeek: {
          $sum: { $cond: [{ $gte: ["$createdAt", sevenDaysAgo] }, 1, 0] },
        },
      },
    },
    { $project: { _id: 0 } },
  ]);

  // An empty collection produces no group at all, so the zeroes are spelled
  // out - the dashboard should render on day one, not crash on undefined.
  const summary = counts || {
    total: 0,
    male: 0,
    female: 0,
    verified: 0,
    disabled: 0,
    newThisWeek: 0,
  };

  /**
   * The three queues. These are what a moderator opens the dashboard to see -
   * "how much is waiting for me" - and each is a covered count against an
   * index, not a scan.
   *
   * Run together rather than in sequence: they are independent, and four
   * awaits in a row makes the dashboard four round trips slower for no reason.
   */
  const [pendingProfiles, openReports, pendingVerifications, pendingPhotos, revenue] =
    await Promise.all([
      Profile.countDocuments({ profileStatus: PROFILE_STATUS.PENDING }),
      Report.countDocuments({ status: "open" }),
      ProfileVerification.countDocuments({ status: "pending" }),
      ProfilePhoto.countDocuments({ isApproved: false, rejectionReason: { $exists: false } }),
      // Money taken, all time. In minor units, like everything else - see the
      // note on the plan schema.
      Payment.aggregate([
        { $match: { status: "succeeded" } },
        { $group: { _id: null, amountMinor: { $sum: "$amountMinor" } } },
      ]),
    ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        ...summary,
        unverifiedMembers: summary.total - summary.verified,
        queues: { pendingProfiles, openReports, pendingVerifications, pendingPhotos },
        revenueMinor: revenue[0]?.amountMinor || 0,
      },
      "Dashboard summary"
    )
  );
});

/**
 * The admin members list.
 *
 * A plain find(): everything the table shows - name, phone, gender, status,
 * joined - is on the account. This was briefly an aggregation with a $lookup
 * into profiles, back when the name lived there; moving the name onto the
 * account took the join with it.
 */
const getMembers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildMemberFilter(req.query);

  const [members, totalCount] = await Promise.all([
    User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { members, pagination: buildPaginationMeta({ page, limit, totalCount }) },
      "Members"
    )
  );
});

/**
 * One member, with the context a support question actually needs.
 *
 * Somebody writes in about a charge, or about being blocked, or about their
 * profile not appearing, and answering any of those from an account row alone
 * means opening four more screens. The counts are the cheap version of those
 * screens: how many people have blocked them is the number that settles a "why
 * can nobody see me" question, and each one is a count against an index.
 */
const getMember = asyncHandler(async (req, res) => {
  const member = await User.findOne({
    _id: req.params.id,
    role: ROLES.MEMBER,
  }).select("-password");

  if (!member) throw new ApiError(404, "Member not found");

  const userId = member._id;

  const [profile, subscription, reportsAgainst, blockedBy, photoCount, sessions] =
    await Promise.all([
      Profile.findOne({ userId }).lean(),
      Subscription.findOne({ userId })
        .sort({ endsAt: -1 })
        .populate("planId", "name")
        .lean(),
      Report.countDocuments({ reportedUserId: userId }),
      Block.countDocuments({ blockedUserId: userId }),
      ProfilePhoto.countDocuments({ userId }),
      RefreshToken.countDocuments({
        userId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
    ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        member,
        profile,
        subscription,
        stats: { reportsAgainst, blockedBy, photoCount, sessions },
      },
      "Member"
    )
  );
});

/**
 * POST /api/v1/admin/users/:id/sign-out - end every session they have.
 *
 * The support answer to "somebody else is in my account". Deliberately not a
 * suspension: the member keeps their account and can sign straight back in,
 * which is exactly what they want once they have changed their password.
 */
const signOutMember = asyncHandler(async (req, res) => {
  const member = await User.findById(req.params.id).select("fullName role");
  if (!member) throw new ApiError(404, "Member not found");

  // A staff member's sessions are a super admin's business, not a moderator's
  if (member.role !== ROLES.MEMBER) {
    const problem = checkStaffMutation({
      actorId: req.user._id,
      actorRole: req.user.role,
      targetId: member._id,
    });
    if (problem) throw new ApiError(403, problem);
  }

  await revokeAllForUser(member._id);

  await recordAudit({
    actor: req.user,
    action: "user.signed_out",
    targetType: "User",
    targetId: member._id,
    note: req.body?.reason,
    ip: req.ip,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, `${member.fullName} was signed out everywhere`));
});

/**
 * Suspend or reinstate an account.
 *
 * Every session is revoked on a suspension, not just the flag flipped:
 * verifyJWT already refuses a suspended account, but a refresh token issued a
 * minute ago would let them mint a fresh access token straight back.
 *
 * A deleted account is never reinstated here. The member closed it themselves,
 * and an admin quietly reopening it is not theirs to do.
 */
const setMemberStatus = asyncHandler(async (req, res) => {
  const { is_active } = req.body;

  if (typeof is_active !== "boolean") {
    throw new ApiError(400, "is_active must be true or false");
  }

  const member = await User.findOneAndUpdate(
    {
      _id: req.params.id,
      role: ROLES.MEMBER,
      accountStatus: { $ne: ACCOUNT_STATUS.DELETED },
    },
    {
      accountStatus: is_active
        ? ACCOUNT_STATUS.ACTIVE
        : ACCOUNT_STATUS.SUSPENDED,
    },
    { new: true }
  );

  if (!member) throw new ApiError(404, "Member not found");

  if (!is_active) await revokeAllForUser(member._id);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        member,
        is_active ? "Account reinstated" : "Account suspended"
      )
    );
});

/**
 * Builds the update for a verify / un-verify.
 *
 * Exported pure because `verifiedAt: undefined` does NOT clear the field -
 * mongoose strips undefined keys out of an update, so the stale date survives
 * and the panel shows "verified on 12 March" for somebody who is not verified.
 * It has to be an explicit $unset, and the check script pins that.
 */
export const buildVerificationUpdate = (isVerified) =>
  isVerified
    ? { $set: { isVerified: true, verifiedAt: new Date() } }
    : { $set: { isVerified: false }, $unset: { verifiedAt: 1 } };

const setMemberVerification = asyncHandler(async (req, res) => {
  const { isVerified } = req.body;

  if (typeof isVerified !== "boolean") {
    throw new ApiError(400, "isVerified must be true or false");
  }

  const member = await User.findOneAndUpdate(
    { _id: req.params.id, role: ROLES.MEMBER },
    buildVerificationUpdate(isVerified),
    { new: true }
  ).select("-password");

  if (!member) throw new ApiError(404, "Member not found");

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        member,
        isVerified ? "Member verified" : "Verification removed"
      )
    );
});

/** The admin/moderator accounts themselves, for the team screen. */
const getStaff = asyncHandler(async (req, res) => {
  const staff = await User.find({ role: { $in: ADMIN_ROLES } })
    .select("-password")
    .sort({ createdAt: 1 })
    .lean();

  return res.status(200).json(new ApiResponse(200, staff, "Staff"));
});

// A super admin can hand out these two and no more. Minting another super
// admin stays with `npm run seed`, on the box, by somebody with shell access -
// an HTTP endpoint that creates the highest role is one stolen admin session
// away from a permanent backdoor.
const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.MODERATOR];

/**
 * Who may change a staff account. Returns a message to refuse with, or null.
 *
 * Pure and exported because this is the privilege boundary of the whole panel:
 * if it is wrong, a moderator promotes themselves and nothing in the UI looks
 * any different.
 *
 * Deliberately says nothing about the role being assigned - see
 * checkAssignableRole. An earlier version took both and skipped the role check
 * when it was undefined, which meant a request that simply omitted `role`
 * sailed through: the create then fell back to the schema default and made a
 * *member*, and the role update became a no-op that still answered 200.
 */
export const checkStaffMutation = ({ actorId, actorRole, targetId }) => {
  if (actorRole !== ROLES.SUPER_ADMIN) {
    return "Only a super admin can manage staff accounts";
  }

  // Self-mutation is refused outright: demoting yourself locks the last super
  // admin out of the panel, and disabling yourself does the same.
  if (actorId && targetId && String(actorId) === String(targetId)) {
    return "You cannot change your own account here";
  }

  return null;
};

/**
 * The role being handed out. Strict, always - a missing role is as invalid as
 * a wrong one, because neither produces the account the caller asked for.
 */
export const checkAssignableRole = (role) =>
  ASSIGNABLE_ROLES.includes(role)
    ? null
    : `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}`;

const createStaff = asyncHandler(async (req, res) => {
  const { fullName, phone, password, gender, role } = req.body;

  const refusal = checkStaffMutation({ actorRole: req.user.role });
  if (refusal) throw new ApiError(403, refusal);

  const badRole = checkAssignableRole(role);
  if (badRole) throw new ApiError(400, badRole);

  const name = requireString(fullName, "Full name");
  const contact = requireString(phone, "Phone");

  if (typeof password !== "string" || password.length < 8) {
    // Longer than the 6 a member gets: this account can read every profile
    // on the site.
    throw new ApiError(400, "Staff password must be at least 8 characters");
  }

  if (!GENDERS.includes(gender)) {
    throw new ApiError(400, `Gender must be one of: ${GENDERS.join(", ")}`);
  }

  if (await User.findOne({ phone: contact })) {
    throw new ApiError(409, "An account with this phone already exists");
  }

  // create(), never insertMany() - only create() runs the pre-save hook that
  // hashes the password, and a staff row with a plaintext password is the
  // worst possible one to get wrong.
  const staff = await User.create({
    fullName: name,
    phone: contact,
    password,
    gender,
    role,
    isVerified: true,
  });

  const { password: _, refreshToken: __, ...safe } = staff.toObject();

  return res.status(201).json(new ApiResponse(201, safe, "Staff account created"));
});

const setStaffRole = asyncHandler(async (req, res) => {
  const { role } = req.body;

  const refusal = checkStaffMutation({
    actorId: req.user._id,
    actorRole: req.user.role,
    targetId: req.params.id,
  });
  if (refusal) throw new ApiError(403, refusal);

  const badRole = checkAssignableRole(role);
  if (badRole) throw new ApiError(400, badRole);

  const staff = await User.findOneAndUpdate(
    { _id: req.params.id, role: { $in: ADMIN_ROLES } },
    { role },
    { new: true }
  ).select("-password");

  if (!staff) throw new ApiError(404, "Staff account not found");

  return res.status(200).json(new ApiResponse(200, staff, "Role updated"));
});

const setStaffStatus = asyncHandler(async (req, res) => {
  const { is_active } = req.body;

  const refusal = checkStaffMutation({
    actorId: req.user._id,
    actorRole: req.user.role,
    targetId: req.params.id,
  });
  if (refusal) throw new ApiError(403, refusal);

  if (typeof is_active !== "boolean") {
    throw new ApiError(400, "is_active must be true or false");
  }

  const staff = await User.findOneAndUpdate(
    { _id: req.params.id, role: { $in: ADMIN_ROLES } },
    {
      accountStatus: is_active
        ? ACCOUNT_STATUS.ACTIVE
        : ACCOUNT_STATUS.SUSPENDED,
    },
    { new: true }
  );

  if (!staff) throw new ApiError(404, "Staff account not found");

  // Same reasoning as a member: the sessions go too, or a suspended admin
  // refreshes themselves straight back in.
  if (!is_active) await revokeAllForUser(staff._id);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        staff,
        is_active ? "Account reinstated" : "Account suspended"
      )
    );
});

export {
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
};
