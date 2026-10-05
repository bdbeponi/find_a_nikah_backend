import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { Profile } from "../models/profile.model.js";
import { User } from "../models/user.model.js";
import { Education } from "../models/education.model.js";
import { Profession } from "../models/profession.model.js";
import { Family } from "../models/family.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { ProfileView } from "../models/profileView.model.js";
import { Like } from "../models/like.model.js";
import { Pass } from "../models/pass.model.js";
import { Match } from "../models/match.model.js";
import { getBlockedUserIds } from "../services/block.service.js";
import { getEntitlements } from "../services/entitlement.service.js";
import {
  buildSearchFilter,
  pickSort,
  preferenceToFilter,
} from "../services/search.service.js";
import { buildPaginationMeta, getPagination } from "../utils/pagination.js";
import { ACCOUNT_STATUS, PROFILE_STATUS, VISIBILITY } from "../constants.js";

/**
 * Which of somebody's photos this viewer is allowed to see.
 *
 * Pure and exported, because getting it wrong is silent in exactly the wrong
 * direction: an unapproved or private photo shown to a stranger looks like a
 * working feature. Two independent gates, and both have to pass - moderation
 * (isApproved) and the member's own choice (visibility).
 */
export const visiblePhotos = (photos = [], { isOwner = false, isMatch = false } = {}) => {
  if (isOwner) return photos;

  return photos.filter((photo) => {
    if (!photo.isApproved) return false;
    if (photo.visibility === VISIBILITY.PUBLIC) return true;
    if (photo.visibility === VISIBILITY.MATCHES_ONLY) return isMatch;
    return false;
  });
};

/**
 * The shape another member sees.
 *
 * Contact details need both a match and a paid plan: a match alone is not
 * enough (the whole point of the plan is the introduction), and a paid plan
 * alone would sell everybody's phone number to anybody with a card.
 */
export const buildPublicProfile = ({
  user,
  profile,
  photos = [],
  education = [],
  profession = [],
  family = null,
  isMatch = false,
  canSeeContactDetails = false,
}) => {
  const contact =
    isMatch && canSeeContactDetails
      ? { phone: user.phone, email: user.email }
      : {};

  return {
    userId: user._id,
    fullName: user.fullName,
    isVerified: user.isVerified,
    lastActiveAt: user.lastActiveAt,
    ...contact,
    profile,
    photos,
    education,
    // toPublicJSON drops the income unless this viewer is allowed it
    profession: profession.map((row) =>
      typeof row.toPublicJSON === "function" ? row.toPublicJSON(isMatch) : row
    ),
    family,
    isMatch,
  };
};

/** The card shape for a list. One query for the photos, not one per row. */
const toCards = async (profiles) => {
  if (!profiles.length) return [];

  const userIds = profiles.map((profile) => profile.userId);

  const [users, photos] = await Promise.all([
    User.find({ _id: { $in: userIds } })
      .select("fullName isVerified lastActiveAt")
      .lean(),
    ProfilePhoto.find({ userId: { $in: userIds }, isApproved: true, isPrimary: true })
      .select("userId url visibility")
      .lean(),
  ]);

  const userById = new Map(users.map((user) => [String(user._id), user]));
  const photoByUser = new Map(photos.map((photo) => [String(photo.userId), photo]));

  return profiles.map((profile) => {
    const key = String(profile.userId);
    const user = userById.get(key);
    const photo = photoByUser.get(key);

    return {
      userId: profile.userId,
      fullName: user?.fullName,
      isVerified: user?.isVerified ?? false,
      lastActiveAt: user?.lastActiveAt,
      // A matches-only primary photo is not shown on a search card: the card is
      // seen by strangers by definition.
      photoUrl: photo?.visibility === VISIBILITY.PUBLIC ? photo.url : null,
      dateOfBirth: profile.dateOfBirth,
      heightCm: profile.heightCm,
      maritalStatus: profile.maritalStatus,
      religion: profile.religion,
      sect: profile.sect,
      city: profile.city,
      country: profile.country,
      completeness: profile.completeness,
      publishedAt: profile.publishedAt,
    };
  });
};

/** Everyone this viewer must never be shown: blocks, and themselves. */
const hiddenFrom = async (userId) => {
  const blocked = await getBlockedUserIds(userId);
  return [...blocked, String(userId)];
};

/** GET /api/v1/profiles/search */
const searchProfiles = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = buildSearchFilter(req.query, { viewerGender: req.user.gender });
  filter.userId = { $nin: await hiddenFrom(req.user._id) };

  // verifiedOnly filters on the account, not the profile, so it is resolved to
  // a list of ids first rather than joined on every row.
  if (req.query.verifiedOnly === "true") {
    filter.userId.$in = await User.find({
      isVerified: true,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
    }).distinct("_id");
  }

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter).sort(pickSort(req.query.sort)).skip(skip).limit(limit).lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: await toCards(profiles),
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "Search results"
    )
  );
});

/**
 * GET /api/v1/profiles/recommendations
 *
 * The member's saved preference, applied as a filter, minus everyone they have
 * already answered. Ranked by completeness: a half-filled profile is the one
 * nobody replies to, and showing it first wastes the only screen that matters.
 *
 * ponytail: a filter and a sort, not a scoring model. Good enough until there
 * is enough behaviour data to learn from - and a scorer with nothing to learn
 * from is just these weights with more code around them.
 */
const getRecommendations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const preference = await PartnerPreference.findOne({ userId: req.user._id }).lean();

  const filter = {
    ...preferenceToFilter(preference),
    ...buildSearchFilter({}, { viewerGender: req.user.gender }),
  };

  // Already liked is already answered - showing them again is the single most
  // annoying thing a recommender does.
  const answered = await Like.find({ fromUserId: req.user._id }).distinct("toUserId");

  filter.userId = {
    $nin: [...(await hiddenFrom(req.user._id)), ...answered.map(String)],
  };

  if (preference?.verifiedOnly) {
    const verified = await User.find({ isVerified: true }).distinct("_id");
    filter.userId = { ...filter.userId, $in: verified };
  }

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter)
      .sort({ completeness: -1, publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: await toCards(profiles),
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        usedPreference: Boolean(preference),
      },
      "Recommended for you"
    )
  );
});

/**
 * GET /api/v1/profiles/:userId
 *
 * A published profile, filtered to what this viewer may see, and the visit is
 * recorded. A blocked pair gets a 404 rather than a 403: a 403 confirms the
 * account exists, which is exactly what somebody who has just been blocked
 * would like to know.
 */
const getPublicProfile = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const viewerId = req.user._id;
  const isOwner = String(userId) === String(viewerId);

  if (!isOwner && (await hiddenFrom(viewerId)).includes(String(userId))) {
    throw new ApiError(404, "Profile not found");
  }

  const [user, profile] = await Promise.all([
    User.findById(userId).select("fullName phone email isVerified lastActiveAt accountStatus"),
    Profile.findOne({ userId }),
  ]);

  if (!user || !profile || user.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
    throw new ApiError(404, "Profile not found");
  }

  if (
    !isOwner &&
    (profile.profileStatus !== PROFILE_STATUS.PUBLISHED || !profile.isDiscoverable)
  ) {
    throw new ApiError(404, "Profile not found");
  }

  const match = isOwner
    ? null
    : await Match.findOne({ users: { $all: [viewerId, userId] }, status: "active" });

  const isMatch = Boolean(match);

  const [photos, education, profession, family, entitlements] = await Promise.all([
    ProfilePhoto.find({ userId }).sort({ isPrimary: -1, createdAt: 1 }),
    Education.find({ userId }).sort({ yearOfPassing: -1 }).lean(),
    Profession.find({ userId }).sort({ isCurrent: -1 }),
    Family.findOne({ userId }).lean(),
    getEntitlements(viewerId),
  ]);

  // Recorded after the profile was found, so a 404 leaves no trace, and upserted
  // on the pair so scrolling back and forth writes one row, not one a second.
  if (!isOwner) {
    await ProfileView.updateOne(
      { viewerId, profileOwnerId: userId },
      { $set: { viewedAt: new Date() }, $inc: { viewCount: 1 } },
      { upsert: true }
    ).catch(() => {});
  }

  const payload = buildPublicProfile({
    user,
    profile,
    photos: visiblePhotos(photos, { isOwner, isMatch }),
    education,
    profession,
    family,
    isMatch,
    canSeeContactDetails: entitlements.canSeeContactDetails,
  });

  // What the button on the card should say
  const liked = isOwner
    ? null
    : await Like.findOne({ fromUserId: viewerId, toUserId: userId }).lean();

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { ...payload, hasLiked: Boolean(liked), matchId: match?._id ?? null },
        "Profile"
      )
    );
});

/**
 * GET /api/v1/profiles/me/viewers - who looked at me.
 *
 * Free members are told the number and not the names. The count is the part
 * that is true either way, and hiding it entirely makes the upgrade look like a
 * guess rather than an offer.
 */
const getMyViewers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = {
    profileOwnerId: req.user._id,
    viewerId: { $nin: await getBlockedUserIds(req.user._id) },
  };

  const totalCount = await ProfileView.countDocuments(filter);
  const entitlements = await getEntitlements(req.user._id);

  if (!entitlements.canSeeWhoLikedMe) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { viewers: [], totalCount, locked: true },
          `${totalCount} people viewed your profile. Upgrade to see who.`
        )
      );
  }

  const views = await ProfileView.find(filter)
    .sort({ viewedAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("viewerId", "fullName isVerified")
    .lean();

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        viewers: views,
        locked: false,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
      },
      "Who viewed your profile"
    )
  );
});

/**
 * GET /api/v1/profiles/me/viewed - profiles this member has looked at.
 *
 * Their own history, so nothing is gated: the paid feature is finding out who
 * looked at *you*, not remembering who you looked at. One row per profile with
 * the latest visit, because that is how the view is recorded - see the note on
 * the ProfileView schema.
 */
const getMyViewed = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const filter = {
    viewerId: req.user._id,
    // Somebody they have since blocked is not a profile they can open again
    profileOwnerId: { $nin: await getBlockedUserIds(req.user._id) },
  };

  const [views, totalCount] = await Promise.all([
    ProfileView.find(filter)
      .sort({ viewedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("profileOwnerId", "fullName isVerified lastActiveAt")
      .lean(),
    ProfileView.countDocuments(filter),
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { views, pagination: buildPaginationMeta({ page, limit, totalCount }) },
        "Profiles you viewed"
      )
    );
});

/**
 * DELETE /api/v1/profiles/me/viewed - clear that history.
 *
 * Only their own side. The rows are also what the other person's "who viewed
 * me" reads, so this genuinely removes the visit from both - which is the
 * honest reading of a member asking to clear it.
 */
const clearMyViewed = asyncHandler(async (req, res) => {
  const { deletedCount } = await ProfileView.deleteMany({ viewerId: req.user._id });

  return res
    .status(200)
    .json(new ApiResponse(200, { removed: deletedCount }, "History cleared"));
});

/**
 * FEED 1: GET /api/v1/profiles/feed/liked-similar
 * Profiles similar to candidates the user has liked
 */
const getLikedSimilar = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);

  // Recent likes sent by user
  const recentLikes = await Like.find({ fromUserId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const likedUserIds = recentLikes.map((l) => l.toUserId);

  let similarFilter = {};
  if (likedUserIds.length > 0) {
    const likedProfiles = await Profile.find({ userId: { $in: likedUserIds } }).lean();
    const sects = [...new Set(likedProfiles.map((p) => p.sect).filter(Boolean))];
    const religions = [...new Set(likedProfiles.map((p) => p.religion).filter(Boolean))];
    const cities = [...new Set(likedProfiles.map((p) => p.city).filter(Boolean))];
    const educations = [...new Set(likedProfiles.map((p) => p.educationLevel).filter(Boolean))];

    const orClauses = [];
    if (sects.length) orClauses.push({ sect: { $in: sects } });
    if (cities.length) orClauses.push({ city: { $in: cities } });
    if (educations.length) orClauses.push({ educationLevel: { $in: educations } });
    if (religions.length) orClauses.push({ religion: { $in: religions } });

    if (orClauses.length > 0) {
      similarFilter.$or = orClauses;
    }
  }

  const viewerGender = req.user.gender;
  const targetGender = viewerGender === "male" ? "female" : "male";

  const filter = {
    gender: targetGender,
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
    userId: { $nin: [...hidden, ...likedUserIds.map(String)] },
    ...similarFilter,
  };

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter)
      .sort({ completeness: -1, publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: await toCards(profiles),
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        tag: "Liked Similar",
      },
      "Profiles similar to those you liked"
    )
  );
});

/**
 * FEED 2: GET /api/v1/profiles/feed/second-look
 * Profiles the user previously passed on, prioritizing those who liked the user
 */
const getSecondLook = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);

  // Find users current user passed on
  const passedRecords = await Pass.find({ passerId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const passedUserIds = passedRecords.map((p) => String(p.passedUserId));

  if (!passedUserIds.length) {
    return res.status(200).json(
      new ApiResponse(
        200,
        { profiles: [], pagination: buildPaginationMeta({ page, limit, totalCount: 0 }) },
        "No passed profiles to reconsider"
      )
    );
  }

  // See if any of these passed users liked the current user
  const whoLikedMe = await Like.find({
    fromUserId: { $in: passedUserIds },
    toUserId: req.user._id,
    status: { $ne: "withdrawn" },
  }).distinct("fromUserId");

  const whoLikedMeSet = new Set(whoLikedMe.map(String));

  const filter = {
    userId: { $in: passedUserIds, $nin: hidden },
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
  };

  const allProfiles = await Profile.find(filter).lean();

  // Prioritize candidates who liked the user
  allProfiles.sort((a, b) => {
    const aLiked = whoLikedMeSet.has(String(a.userId));
    const bLiked = whoLikedMeSet.has(String(b.userId));
    if (aLiked && !bLiked) return -1;
    if (!aLiked && bLiked) return 1;
    return 0;
  });

  const paginatedProfiles = allProfiles.slice(skip, skip + limit);
  const cards = await toCards(paginatedProfiles);

  const enhancedCards = cards.map((card) => ({
    ...card,
    theyLikedYou: whoLikedMeSet.has(String(card.userId)),
  }));

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: enhancedCards,
        pagination: buildPaginationMeta({ page, limit, totalCount: allProfiles.length }),
        tag: "Second Look",
      },
      "Second Look profiles"
    )
  );
});

/**
 * FEED 3: GET /api/v1/profiles/feed/live
 * Currently available members (active recently within last 30 minutes)
 */
const getLiveUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);

  const targetGender = req.user.gender === "male" ? "female" : "male";
  const recentThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes

  const activeUserIds = await User.find({
    gender: targetGender,
    accountStatus: ACCOUNT_STATUS.ACTIVE,
    lastActiveAt: { $gte: recentThreshold },
    _id: { $nin: hidden },
  })
    .sort({ lastActiveAt: -1 })
    .distinct("_id");

  const filter = {
    userId: { $in: activeUserIds },
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
  };

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Profile.countDocuments(filter),
  ]);

  const cards = await toCards(profiles);
  const liveCards = cards.map((c) => ({ ...c, isLive: true }));

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: liveCards,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        tag: "Currently Available",
      },
      "Currently available members"
    )
  );
});

/**
 * FEED 4: GET /api/v1/profiles/feed/visited-you
 * Profiles of users who visited your profile
 */
const getVisitedYou = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);

  const views = await ProfileView.find({
    profileOwnerId: req.user._id,
    viewerId: { $nin: hidden },
  })
    .sort({ viewedAt: -1 })
    .lean();

  const viewerIds = views.map((v) => v.viewerId);
  const viewMap = new Map(views.map((v) => [String(v.viewerId), v.viewedAt]));

  const filter = {
    userId: { $in: viewerIds },
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
  };

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter).skip(skip).limit(limit).lean(),
    Profile.countDocuments(filter),
  ]);

  const cards = await toCards(profiles);
  const enriched = cards.map((c) => ({
    ...c,
    viewedAt: viewMap.get(String(c.userId)),
  }));

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: enriched,
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        tag: "Visited You",
      },
      "Members who visited your profile"
    )
  );
});

/**
 * FEED 5: GET /api/v1/profiles/feed/just-joined
 * Profiles of members who joined recently (last 14 days)
 */
const getJustJoined = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);
  const targetGender = req.user.gender === "male" ? "female" : "male";

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const filter = {
    gender: targetGender,
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
    userId: { $nin: hidden },
    createdAt: { $gte: fourteenDaysAgo },
  };

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: await toCards(profiles),
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        tag: "Just Joined",
      },
      "Recently joined members"
    )
  );
});

/**
 * FEED 6: GET /api/v1/profiles/feed/near-you
 * Profiles of members geographically close to you
 */
const getNearYou = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const hidden = await hiddenFrom(req.user._id);
  const targetGender = req.user.gender === "male" ? "female" : "male";

  const myProfile = await Profile.findOne({ userId: req.user._id }).lean();

  const filter = {
    gender: targetGender,
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
    userId: { $nin: hidden },
  };

  const coords = myProfile?.location?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) {
    const maxMeters = myProfile.locationRadius === "small" ? 30_000 : 100_000;
    filter.location = {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: maxMeters,
      },
    };
  } else if (myProfile?.city) {
    filter.city = new RegExp(`^${myProfile.city}$`, "i");
  }

  const [profiles, totalCount] = await Promise.all([
    Profile.find(filter).skip(skip).limit(limit).lean(),
    Profile.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        profiles: await toCards(profiles),
        pagination: buildPaginationMeta({ page, limit, totalCount }),
        tag: "Active Near You",
      },
      "Members active near your location"
    )
  );
});

export {
  searchProfiles,
  getRecommendations,
  getPublicProfile,
  getMyViewers,
  getMyViewed,
  clearMyViewed,
  getLikedSimilar,
  getSecondLook,
  getLiveUsers,
  getVisitedYou,
  getJustJoined,
  getNearYou,
};
