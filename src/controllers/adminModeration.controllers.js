import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { getPagination, buildPaginationMeta } from "../utils/pagination.js";
import { searchRegex } from "../utils/search.js";
import { AuditLog } from "../models/auditLog.model.js";
import { Profile } from "../models/profile.model.js";
import { Report } from "../models/report.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import { Education } from "../models/education.model.js";
import { Profession } from "../models/profession.model.js";
import { Family } from "../models/family.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { User } from "../models/user.model.js";
import { recordAudit } from "../services/audit.service.js";
import { revokeAllForUser } from "../services/auth.service.js";
import {
  ACCOUNT_STATUS,
  PROFILE_STATUS,
  PROFILE_STATUSES,
  REPORT_STATUSES,
  VERIFICATION_STATUSES,
} from "../constants.js";

/* ------------------------------------------------------------------ profiles */

/**
 * Filter for the profile moderation queue - only the clauses that live on
 * Profile itself. The name is on the account, so listProfiles resolves that
 * separately.
 *
 * Pure and exported for the same reason as buildMemberFilter: a filter that
 * silently ignores `status=pending` shows an empty queue, and an empty queue
 * looks exactly like a queue you have finished.
 */
export const buildProfileFilter = (query = {}) => {
  const filter = {};

  if (PROFILE_STATUSES.includes(query.status)) {
    filter.profileStatus = query.status;
  }

  if (query.city) filter.city = searchRegex(query.city);
  if (query.religion) filter.religion = query.religion;

  if (query.discoverable === "true" || query.discoverable === "false") {
    filter.isDiscoverable = query.discoverable === "true";
  }

  return filter;
};

const listProfiles = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildProfileFilter(req.query);

  /**
   * A name search runs against users first and narrows the profile query by
   * id.
   *
   * populate() cannot do this: it fetches the profiles, then resolves their
   * users, then would have to discard the ones that do not match - which
   * breaks both the page size and the count. Two queries is the honest way.
   */
  const term = searchRegex(req.query.search);
  if (term) {
    const ids = await User.find({ fullName: term }).distinct("_id");
    filter.userId = { $in: ids };
  }

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter)
      // Oldest first: a moderation queue that shows newest first leaves the
      // person who has waited longest at the bottom forever.
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName phone email accountStatus isVerified createdAt")
      .lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { profiles, pagination: buildPaginationMeta({ page, limit, totalCount }) },
      "Profiles"
    )
  );
});

/**
 * One profile, whole.
 *
 * Everything the member filled in, not just the Profile document: a moderator
 * deciding whether to publish somebody is deciding about the education, the
 * profession and the photos too, and a screen that shows only the summary makes
 * them approve what they have not read.
 *
 * Photos come back unfiltered - approved or not, whatever the member's own
 * visibility says. That is the whole point of the queue, and it is the one
 * place in the codebase where visiblePhotos is deliberately not used.
 */
const getProfile = asyncHandler(async (req, res) => {
  const profile = await Profile.findById(req.params.id).populate(
    "userId",
    "fullName phone email accountStatus isVerified lastActiveAt createdAt"
  );

  if (!profile) throw new ApiError(404, "Profile not found");

  const userId = profile.userId?._id || profile.userId;

  const [education, profession, family, preference, photos, reportCount] =
    await Promise.all([
      Education.find({ userId }).sort({ yearOfPassing: -1 }).lean(),
      Profession.find({ userId }).sort({ isCurrent: -1 }).lean(),
      Family.findOne({ userId }).lean(),
      PartnerPreference.findOne({ userId }).lean(),
      ProfilePhoto.find({ userId }).sort({ isPrimary: -1, createdAt: 1 }).lean(),
      Report.countDocuments({ reportedUserId: userId }),
    ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { profile, education, profession, family, preference, photos, reportCount },
      "Profile"
    )
  );
});

/**
 * Publish, reject or hide a profile.
 *
 * publishedAt is set once and never moved, so "recently published" stays
 * meaningful after a profile is hidden and published again - otherwise every
 * re-publish would shove an old member back to the top of the feed.
 */
const setProfileStatus = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;

  if (!PROFILE_STATUSES.includes(status)) {
    throw new ApiError(400, `Status must be one of: ${PROFILE_STATUSES.join(", ")}`);
  }

  if (status === PROFILE_STATUS.REJECTED && !rejectionReason?.trim()) {
    // A rejection with no reason is one the member cannot act on, and it comes
    // straight back into the queue unchanged.
    throw new ApiError(400, "A rejection needs a reason");
  }

  const profile = await Profile.findById(req.params.id);
  if (!profile) throw new ApiError(404, "Profile not found");

  const previous = profile.profileStatus;

  profile.profileStatus = status;
  profile.rejectionReason =
    status === PROFILE_STATUS.REJECTED ? rejectionReason.trim() : undefined;

  if (status === PROFILE_STATUS.PUBLISHED && !profile.publishedAt) {
    profile.publishedAt = new Date();
  }

  await profile.save();

  await recordAudit({
    actor: req.user,
    action: `profile.${status}`,
    targetType: "Profile",
    targetId: profile._id,
    before: { profileStatus: previous },
    after: { profileStatus: status },
    note: profile.rejectionReason,
    ip: req.ip,
  });

  return res.status(200).json(new ApiResponse(200, profile, `Profile ${status}`));
});

/* ------------------------------------------------------------------- reports */

export const buildReportFilter = (query = {}) => {
  const filter = {};

  if (REPORT_STATUSES.includes(query.status)) filter.status = query.status;
  if (query.reason) filter.reason = query.reason;

  return filter;
};

const listReports = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildReportFilter(req.query);

  const [reports, totalCount] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("reporterId", "fullName phone")
      .populate("reportedUserId", "fullName phone accountStatus")
      .lean(),
    Report.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { reports, pagination: buildPaginationMeta({ page, limit, totalCount }) },
      "Reports"
    )
  );
});

const getReport = asyncHandler(async (req, res) => {
  const report = await Report.findById(req.params.id)
    .populate("reporterId", "fullName phone createdAt")
    .populate("reportedUserId", "fullName phone accountStatus isVerified createdAt");

  if (!report) throw new ApiError(404, "Report not found");

  // How often this person has been reported is the number that decides what to
  // do, and it is not on the report itself.
  const priorReports = await Report.countDocuments({
    reportedUserId: report.reportedUserId,
    _id: { $ne: report._id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { report, priorReports }, "Report"));
});

/**
 * Resolve a report, optionally suspending the person it names.
 *
 * Three documents change and there is no transaction on this deployment, so
 * the ORDER is the safety mechanism:
 *
 *   1. suspend the user  - the consequential act, and idempotent: setting
 *                          accountStatus to "suspended" twice is the same as
 *                          once, so a retry after a crash is harmless.
 *   2. close the report  - if step 1 crashed we never get here, and the report
 *                          stays open for the moderator to try again.
 *   3. write the audit   - never throws; see audit.service.js.
 *
 * The failure this ordering accepts is a suspended user whose report is still
 * open. That is visible, safe, and fixed by pressing the button again. The
 * reverse order would give a closed report and an un-suspended user, which
 * nobody would ever notice.
 */
const resolveReport = asyncHandler(async (req, res) => {
  const { status, resolutionNote, suspendUser } = req.body;

  if (!["resolved", "dismissed", "reviewing"].includes(status)) {
    throw new ApiError(400, "Status must be reviewing, resolved or dismissed");
  }

  const report = await Report.findById(req.params.id);
  if (!report) throw new ApiError(404, "Report not found");

  const previous = report.status;

  if (suspendUser === true) {
    const suspended = await User.findOneAndUpdate(
      {
        _id: report.reportedUserId,
        accountStatus: { $ne: ACCOUNT_STATUS.DELETED },
      },
      { accountStatus: ACCOUNT_STATUS.SUSPENDED },
      { new: true }
    );

    if (!suspended) throw new ApiError(404, "The reported account no longer exists");

    // Their live sessions go too, or a suspended account keeps working until
    // its access token expires.
    await revokeAllForUser(suspended._id);

    await recordAudit({
      actor: req.user,
      action: "user.suspend",
      targetType: "User",
      targetId: suspended._id,
      after: { accountStatus: ACCOUNT_STATUS.SUSPENDED },
      note: `From report ${report._id}`,
      ip: req.ip,
    });
  }

  report.status = status;
  report.resolutionNote = resolutionNote?.trim();
  report.reviewedBy = req.user._id;
  report.reviewedAt = new Date();
  await report.save();

  await recordAudit({
    actor: req.user,
    action: `report.${status}`,
    targetType: "Report",
    targetId: report._id,
    before: { status: previous },
    after: { status },
    note: report.resolutionNote,
    ip: req.ip,
  });

  return res.status(200).json(new ApiResponse(200, report, `Report ${status}`));
});

/* -------------------------------------------------------------- verifications */

const listVerifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = VERIFICATION_STATUSES.includes(req.query.status)
    ? { status: req.query.status }
    : {};

  const [verifications, totalCount] = await Promise.all([
    ProfileVerification.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "fullName phone accountStatus isVerified")
      .lean(),
    ProfileVerification.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        verifications,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "Verification requests"
    )
  );
});

/**
 * Approve or reject an identity document.
 *
 * Two documents again, same reasoning as resolveReport: the User flag is set
 * first because it is what the rest of the site reads, and it is idempotent.
 * A crash between the two leaves a verified member with a request still marked
 * pending - the moderator sees it in the queue and approves again, harmlessly.
 */
const reviewVerification = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    throw new ApiError(400, "Status must be approved or rejected");
  }

  if (status === "rejected" && !rejectionReason?.trim()) {
    throw new ApiError(400, "A rejection needs a reason");
  }

  const request = await ProfileVerification.findById(req.params.id);
  if (!request) throw new ApiError(404, "Verification request not found");

  if (request.status !== "pending") {
    throw new ApiError(409, `This request was already ${request.status}`);
  }

  const approved = status === "approved";

  const user = await User.findByIdAndUpdate(
    request.userId,
    approved
      ? { $set: { isVerified: true, verifiedAt: new Date() } }
      : { $set: { isVerified: false }, $unset: { verifiedAt: 1 } },
    { new: true }
  );

  if (!user) throw new ApiError(404, "That account no longer exists");

  request.status = status;
  request.rejectionReason = approved ? undefined : rejectionReason.trim();
  request.reviewedBy = req.user._id;
  request.reviewedAt = new Date();
  await request.save();

  await recordAudit({
    actor: req.user,
    action: `verification.${status}`,
    targetType: "ProfileVerification",
    targetId: request._id,
    after: { status, isVerified: approved },
    note: request.rejectionReason,
    ip: req.ip,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, request, `Verification ${status}`));
});

/* ---------------------------------------------------------------- audit trail */

const listAuditLog = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};
  if (req.query.action) filter.action = req.query.action;
  if (req.query.actorId) filter.actorId = req.query.actorId;
  // "everything ever done to this member" - the question the member detail
  // screen asks, and the one support asks when somebody phones up wanting to
  // know why their profile came down.
  if (req.query.targetType) filter.targetType = req.query.targetType;
  if (req.query.targetId) filter.targetId = req.query.targetId;

  const [entries, totalCount] = await Promise.all([
    // Newest first here, unlike the queues: this is a history, not a to-do list
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("actorId", "fullName phone role")
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { entries, pagination: buildPaginationMeta({ page, limit, totalCount }) },
      "Audit log"
    )
  );
});

export {
  listProfiles,
  getProfile,
  setProfileStatus,
  listReports,
  getReport,
  resolveReport,
  listVerifications,
  reviewVerification,
  listAuditLog,
};
