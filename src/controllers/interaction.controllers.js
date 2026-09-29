import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { Like } from "../models/like.model.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";
import { Report } from "../models/report.model.js";
import { Conversation } from "../models/conversation.model.js";
import { getEntitlements } from "../services/entitlement.service.js";
import { isBlockedBetween } from "../services/block.service.js";
import { announceMatch, ensureMatch } from "../services/match.service.js";
import { notify } from "../services/notification.service.js";
import { emitToUser } from "../socket/emit.js";
import { buildPaginationMeta, getPagination } from "../utils/pagination.js";
import {
  ACCOUNT_STATUS,
  PROFILE_STATUS,
  REPORT_REASONS,
} from "../constants.js";

/** Midnight this morning, for the daily like counter. */
const startOfToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

/**
 * The checks every "do something to another member" endpoint shares.
 *
 * One function rather than four copies: the likes, blocks and reports paths all
 * need the same three answers, and a check that exists in three of the four
 * places is the one that gets exploited.
 */
const resolveTarget = async (viewer, targetId, { requirePublished = true } = {}) => {
  if (String(targetId) === String(viewer._id)) {
    throw new ApiError(400, "That is you");
  }

  const target = await User.findById(targetId).select(
    "fullName accountStatus gender"
  );

  if (!target || target.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
    throw new ApiError(404, "Member not found");
  }

  if (await isBlockedBetween(viewer._id, targetId)) {
    // Same 404 a missing account gets. A 403 here confirms they exist, which is
    // the one thing somebody who has just been blocked wants confirmed.
    throw new ApiError(404, "Member not found");
  }

  if (requirePublished) {
    const profile = await Profile.findOne({ userId: targetId })
      .select("profileStatus isDiscoverable")
      .lean();

    if (
      !profile ||
      profile.profileStatus !== PROFILE_STATUS.PUBLISHED ||
      !profile.isDiscoverable
    ) {
      throw new ApiError(404, "Member not found");
    }
  }

  return target;
};

/**
 * POST /api/v1/likes/:userId
 *
 * A second tap does not fail. The unique index means the insert throws E11000,
 * and rather than answering "you already did that" the handler carries on to
 * the match check - which is what repairs a first attempt that crashed between
 * writing the like and making the match. See ensureMatch.
 */
const likeMember = asyncHandler(async (req, res) => {
  const target = await resolveTarget(req.user, req.params.userId);

  const entitlements = await getEntitlements(req.user._id);

  // Looked up before the counter is spent, so a repeat tap on somebody they
  // already liked never costs them one of the day's likes.
  let alreadyLiked = Boolean(
    await Like.exists({ fromUserId: req.user._id, toUserId: target._id })
  );

  const usedToday = await Like.countDocuments({
    fromUserId: req.user._id,
    createdAt: { $gte: startOfToday() },
  });

  if (!alreadyLiked) {
    if (usedToday >= entitlements.maxLikesPerDay) {
      throw new ApiError(
        403,
        `You have used all ${entitlements.maxLikesPerDay} likes for today. Upgrade for more.`
      );
    }

    try {
      await Like.create({ fromUserId: req.user._id, toUserId: target._id });
    } catch (err) {
      // Two taps in flight at once. The index is what actually prevents the
      // duplicate; this just turns it back into the ordinary case.
      if (err?.code !== 11000) throw err;
      alreadyLiked = true;
    }
  }

  const reciprocal = await Like.findOne({
    fromUserId: target._id,
    toUserId: req.user._id,
    status: { $ne: "withdrawn" },
  }).lean();

  if (reciprocal) {
    const { match, conversation } = await ensureMatch(req.user._id, target._id);

    await announceMatch({
      match,
      conversation,
      names: {
        [String(req.user._id)]: req.user.fullName,
        [String(target._id)]: target.fullName,
      },
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        { matched: true, matchId: match._id, conversationId: conversation._id },
        `You and ${target.fullName} liked each other`
      )
    );
  }

  if (!alreadyLiked) {
    await notify({
      userId: target._id,
      type: "like_received",
      title: "Someone is interested",
      body: `${req.user.fullName} liked your profile`,
      data: { userId: req.user._id },
    });
  }

  return res
    .status(alreadyLiked ? 200 : 201)
    .json(
      new ApiResponse(
        alreadyLiked ? 200 : 201,
        { matched: false, remaining: Math.max(0, entitlements.maxLikesPerDay - usedToday - 1) },
        alreadyLiked ? "Already liked" : "Liked"
      )
    );
});

/**
 * DELETE /api/v1/likes/:userId - take it back.
 *
 * Only while it is still pending. Withdrawing a like that already became a
 * match would leave a conversation with no match behind it; unmatching is the
 * endpoint for that, and it says so.
 */
const unlikeMember = asyncHandler(async (req, res) => {
  const like = await Like.findOne({
    fromUserId: req.user._id,
    toUserId: req.params.userId,
  });

  if (!like) throw new ApiError(404, "You have not liked them");

  if (like.status === "matched") {
    throw new ApiError(409, "You are matched - unmatch instead");
  }

  await like.deleteOne();

  return res.status(200).json(new ApiResponse(200, null, "Like withdrawn"));
});

/**
 * GET /api/v1/likes/received
 *
 * Who is behind the likes is a paid feature; how many there are is not. The
 * count is honest either way, and a hidden count makes the upgrade a guess.
 */
const getLikesReceived = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = { toUserId: req.user._id, status: "pending" };
  const totalCount = await Like.countDocuments(filter);
  const entitlements = await getEntitlements(req.user._id);

  if (!entitlements.canSeeWhoLikedMe) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { likes: [], totalCount, locked: true },
          `${totalCount} people like you. Upgrade to see who.`
        )
      );
  }

  const likes = await Like.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("fromUserId", "fullName isVerified lastActiveAt")
    .lean();

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        likes,
        locked: false,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "People who liked you"
    )
  );
});

/** GET /api/v1/likes/sent */
const getLikesSent = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { fromUserId: req.user._id };

  const [likes, totalCount] = await Promise.all([
    Like.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("toUserId", "fullName isVerified")
      .lean(),
    Like.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { likes, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Likes you sent"
      )
    );
});

/** GET /api/v1/matches */
const getMatches = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = { users: req.user._id, status: req.query.status || "active" };

  const [matches, totalCount] = await Promise.all([
    Match.find(filter)
      .sort({ matchedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("users", "fullName isVerified lastActiveAt")
      .lean(),
    Match.countDocuments(filter),
  ]);

  // The other person is what the list is about, so the client is not left to
  // work out which of the two ids is not theirs.
  const withPartner = matches.map((match) => ({
    ...match,
    partner: match.users.find((user) => String(user._id) !== String(req.user._id)),
  }));

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { matches: withPartner, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Your matches"
      )
    );
});

/**
 * DELETE /api/v1/matches/:id
 *
 * The row stays. Deleting it would take the conversation's anchor with it and
 * leave the other side with a thread that points at nothing - and unmatchedBy
 * is the field that lets them be told it was not their doing.
 */
const unmatch = asyncHandler(async (req, res) => {
  const match = await Match.findOne({ _id: req.params.id, users: req.user._id });

  if (!match) throw new ApiError(404, "Match not found");
  if (match.status !== "active") {
    return res.status(200).json(new ApiResponse(200, null, "Already unmatched"));
  }

  match.status = "unmatched";
  match.unmatchedBy = req.user._id;
  match.unmatchedAt = new Date();
  await match.save();

  const other = match.users.find(
    (user) => String(user) !== String(req.user._id)
  );

  emitToUser(other, "match:ended", { matchId: match._id });

  return res.status(200).json(new ApiResponse(200, null, "Unmatched"));
});

/**
 * POST /api/v1/blocks/:userId
 *
 * Blocking ends an active match in the same breath. A block that leaves the
 * conversation open is not a block, and the member who pressed it will not go
 * looking for a second button.
 *
 * Order, with no transaction to lean on:
 *   1. the block   - the consequential act, idempotent under a unique index
 *   2. the unmatch - if step 1 failed we never get here, and a block with a
 *                    live match is recoverable by pressing it again
 */
const blockMember = asyncHandler(async (req, res) => {
  const target = await resolveTarget(req.user, req.params.userId, {
    requirePublished: false,
  });

  await Block.updateOne(
    { blockerId: req.user._id, blockedUserId: target._id },
    { $set: { reason: req.body?.reason } },
    { upsert: true }
  );

  await Match.updateOne(
    { users: { $all: [req.user._id, target._id] }, status: "active" },
    {
      $set: {
        status: "unmatched",
        unmatchedBy: req.user._id,
        unmatchedAt: new Date(),
      },
    }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, null, `${target.fullName} is blocked`));
});

/** DELETE /api/v1/blocks/:userId - unblocking does not restore the match. */
const unblockMember = asyncHandler(async (req, res) => {
  const removed = await Block.findOneAndDelete({
    blockerId: req.user._id,
    blockedUserId: req.params.userId,
  });

  if (!removed) throw new ApiError(404, "They are not blocked");

  return res.status(200).json(new ApiResponse(200, null, "Unblocked"));
});

/** GET /api/v1/blocks - only the ones this member made, never who blocked them. */
const getBlocks = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { blockerId: req.user._id };

  const [blocks, totalCount] = await Promise.all([
    Block.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("blockedUserId", "fullName")
      .lean(),
    Block.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { blocks, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "People you blocked"
      )
    );
});

/**
 * POST /api/v1/reports
 *
 * Feeds the moderation queue the admin panel already reads. The duplicate guard
 * is the partial unique index, so a member who taps twice gets told once rather
 * than filing two.
 */
const createReport = asyncHandler(async (req, res) => {
  const { reportedUserId, reason, description } = req.body || {};

  if (!REPORT_REASONS.includes(reason)) {
    throw new ApiError(400, `Reason must be one of: ${REPORT_REASONS.join(", ")}`);
  }

  // A suspended or hidden profile is exactly the one worth reporting, so the
  // published check is off here.
  const target = await resolveTarget(req.user, reportedUserId, {
    requirePublished: false,
  });

  try {
    const report = await Report.create({
      reporterId: req.user._id,
      reportedUserId: target._id,
      reason,
      description,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, report, "Reported - a moderator will look at it"));
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError(409, "You already have an open report about them");
    }
    throw err;
  }
});

/** GET /api/v1/reports/mine */
const getMyReports = asyncHandler(async (req, res) => {
  const reports = await Report.find({ reporterId: req.user._id })
    .sort({ createdAt: -1 })
    .select("-reviewedBy")
    .populate("reportedUserId", "fullName")
    .lean();

  return res.status(200).json(new ApiResponse(200, reports, "Reports you filed"));
});

/** GET /api/v1/matches/:id/conversation - the thread behind a match. */
const getMatchConversation = asyncHandler(async (req, res) => {
  const match = await Match.findOne({ _id: req.params.id, users: req.user._id });
  if (!match) throw new ApiError(404, "Match not found");

  const conversation = await Conversation.findOne({ matchId: match._id });
  if (!conversation) throw new ApiError(404, "No conversation yet");

  return res.status(200).json(new ApiResponse(200, conversation, "Conversation"));
});

export {
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
  startOfToday,
};
