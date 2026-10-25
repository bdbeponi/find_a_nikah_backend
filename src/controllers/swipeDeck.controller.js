import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { Like } from "../models/like.model.js";
import { Pass } from "../models/pass.model.js";
import { Match } from "../models/match.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { getBlockedUserIds } from "../services/block.service.js";
import { getEntitlements } from "../services/entitlement.service.js";
import { ensureMatch } from "../services/match.service.js";
import { ageRangeToDob, dobForAge } from "../services/search.service.js";
import { escapeRegex } from "../utils/search.js";
import {
  ACCOUNT_STATUS,
  PROFILE_STATUS,
  VISIBILITY,
  MIN_AGE,
  MAX_AGE,
} from "../constants.js";

const parseCoords = (coords) => {
  if (!coords) return [null, null];
  if (Array.isArray(coords)) return [coords[1], coords[0]]; // [lat, lon]
  if (Array.isArray(coords.coordinates)) return [coords.coordinates[1], coords.coordinates[0]];
  const lat =
    coords.latitude ??
    coords.lati ??
    coords.lat ??
    coords.coordinates?.latitude ??
    coords.coordinates?.lat ??
    coords.coordinates?.[1];
  const lon =
    coords.longitude ??
    coords.longi ??
    coords.lng ??
    coords.coordinates?.longitude ??
    coords.coordinates?.lng ??
    coords.coordinates?.[0];
  return [Number(lat), Number(lon)];
};

/**
 * Calculates straight-line distance in kilometers between two geo coordinate sets
 * using the Haversine formula.
 */
const calculateDistanceKm = (coords1, coords2) => {
  if (!coords1 || !coords2) return null;

  const [lat1, lon1] = parseCoords(coords1);
  const [lat2, lon2] = parseCoords(coords2);

  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return null;
  }

  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
};

/**
 * Calculates whole years age from Date of Birth.
 */
const calculateAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age;
};

/**
 * Flattens all 5 categories of interests into a single clean array of strings.
 */
const flattenInterests = (interestsObj) => {
  if (!interestsObj || typeof interestsObj !== "object") return [];
  const cultural = Array.isArray(interestsObj.cultural)
    ? interestsObj.cultural
    : [];
  const foodDrinks = Array.isArray(interestsObj.foodDrinks)
    ? interestsObj.foodDrinks
    : [];
  const sports = Array.isArray(interestsObj.sports) ? interestsObj.sports : [];
  const fashion = Array.isArray(interestsObj.fashion)
    ? interestsObj.fashion
    : [];
  const activities = Array.isArray(interestsObj.activities)
    ? interestsObj.activities
    : [];

  return [...cultural, ...foodDrinks, ...sports, ...fashion, ...activities]
    .filter(Boolean)
    .map((item) => String(item).trim());
};

/**
 * Collects all user IDs that should NOT be shown in the card deck:
 * - The viewer themselves
 * - Blocked or blocker accounts
 * - Already liked
 * - Already passed (unless rewound)
 * - Already matched
 * - Any IDs currently held in the client's local memory buffer (passed via `excludeIds`)
 */
const getExcludedUserIds = async (viewerId, clientExcludeIds = []) => {
  const [blocked, liked, passed, matches] = await Promise.all([
    getBlockedUserIds(viewerId),
    Like.find({ fromUserId: viewerId }).distinct("toUserId"),
    Pass.find({ passerId: viewerId }).distinct("passedUserId"),
    Match.find({ users: viewerId, status: "active" }).select("users").lean(),
  ]);

  const matchedUserIds = matches.flatMap((m) =>
    (m.users || []).map(String).filter((id) => id !== String(viewerId))
  );

  const excludeSet = new Set([
    String(viewerId),
    ...blocked.map(String),
    ...liked.map(String),
    ...passed.map(String),
    ...matchedUserIds,
    ...clientExcludeIds.map(String),
  ]);

  return Array.from(excludeSet);
};

/**
 * Formats a profile and its associated user into a high-performance,
 * zero-render-lag card object ready for client-side Tinder swipe UI.
 */
const buildSwipeCard = ({
  profile,
  user,
  photos = [],
  viewerInterests = [],
  viewerCoords = null,
}) => {
  // Combine profile.images and approved public ProfilePhotos without duplicates
  const rawImages = [
    ...(Array.isArray(profile.images) ? profile.images : []),
    ...photos.map((p) => p.url),
  ]
    .filter(Boolean)
    .map((url) => String(url).trim());

  const uniqueImages = [...new Set(rawImages)];

  // Flatten candidate interests and calculate shared overlap with viewer
  const candidateInterests = flattenInterests(profile.interests);
  const viewerSet = new Set(viewerInterests.map((t) => t.toLowerCase()));
  const sharedInterests = candidateInterests.filter((tag) =>
    viewerSet.has(tag.toLowerCase())
  );

  // Compute distance if coordinates available
  const candidateCoords = profile.location?.coordinates || null;
  const distanceKm = calculateDistanceKm(viewerCoords, candidateCoords);

  // Compute match score: base 60 + 10 per shared interest + 5 verified + 5 with photos
  let matchScore = 60;
  matchScore += Math.min(25, sharedInterests.length * 8);
  if (user?.isVerified) matchScore += 5;
  if (uniqueImages.length >= 2) matchScore += 5;
  if (matchScore > 98) matchScore = 98;

  const age = calculateAge(profile.dateOfBirth);

  return {
    userId: profile.userId,
    profileId: profile._id,
    fullName: user?.fullName || "Member",
    isVerified: Boolean(user?.isVerified),
    lastActiveAt: user?.lastActiveAt || null,
    age,
    dateOfBirth: profile.dateOfBirth,
    gender: profile.gender,
    religion: profile.religion,
    faith: profile.faith || [],
    ethnicity: profile.ethnicity || [],
    country: profile.country || "Bangladesh",
    location: profile.location || null,
    distanceKm,
    aboutMe: profile.aboutMe || "",
    educationLevel: profile.educationLevel || "",
    professionTitle: profile.professionTitle || "",
    maritalStatus: profile.maritalStatus || "never_married",
    heightCm: profile.heightCm || null,
    images: uniqueImages,
    primaryPhoto: uniqueImages[0] || null,
    interests: profile.interests || {},
    allInterests: candidateInterests,
    sharedInterests,
    sharedCount: sharedInterests.length,
    matchScore,
    completeness: profile.completeness || 0,
  };
};


export const getSwipeCards = asyncHandler(async (req, res) => {
  const viewerId = req.user._id;

  // 1. Fetch viewer user, profile, and partner preferences
  const [viewerUser, viewerProfile, viewerPref] = await Promise.all([
    User.findById(viewerId).select("gender fullName email isVerified").lean(),
    Profile.findOne({ userId: viewerId }).lean(),
    PartnerPreference.findOne({ userId: viewerId }).lean(),
  ]);

  // 2. Gender: Automatic opposite (male -> female, female -> male)
  const viewerGender =
    req.user.gender || viewerUser?.gender || viewerProfile?.gender || "male";
  const targetGender =
    req.query.gender || (viewerGender === "male" ? "female" : "male");

  // 3. Religion: Automatic same religion (or query override)
  const viewerReligion = viewerProfile?.religion || "islam";
  const targetReligion = req.query.religion || viewerReligion;

  // 4. Batch Limit: default 3 cards for instant zero-render local buffer (up to 20)
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 3));

  // 5. Exclusions:
  // Parse client-supplied excludeIds (profiles already cached in client store)
  const clientExcludeIds = (req.query.excludeIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const excludedUserIds = await getExcludedUserIds(viewerId, clientExcludeIds);

  // 6. Build Demographic Filter
  const filter = {
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
    gender: targetGender,
    userId: { $nin: excludedUserIds },
  };

  if (targetReligion) {
    filter.religion = targetReligion;
  }

  // Age range to Date of Birth
  const minAge =
    Number(req.query.minAge) || viewerPref?.ageRange?.min || MIN_AGE;
  const maxAge =
    Number(req.query.maxAge) || viewerPref?.ageRange?.max || MAX_AGE;
  const dobRange = ageRangeToDob(minAge, maxAge);
  if (dobRange) {
    filter.dateOfBirth = dobRange;
  }

  // Ethnicity filter
  const ethnicityQuery = req.query.ethnicity;
  if (ethnicityQuery) {
    const list = String(ethnicityQuery)
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (list.length) {
      filter.ethnicity = { $in: list };
    }
  }

  // Faith filter
  const faithQuery = req.query.faith || req.query.sect;
  if (faithQuery) {
    const list = String(faithQuery)
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    if (list.length) {
      filter.faith = { $in: list };
    }
  }

  // Country filter
  if (req.query.country) {
    filter.country = new RegExp(escapeRegex(req.query.country.trim()), "i");
  }

  // City filter
  if (req.query.city) {
    filter.city = new RegExp(escapeRegex(req.query.city.trim()), "i");
  }

  // 7. Viewer interests and coordinates for distance and scoring
  const viewerInterests = flattenInterests(viewerProfile?.interests);
  const viewerCoords =
    (req.query.latitude && req.query.longitude
      ? {
        latitude: Number(req.query.latitude),
        longitude: Number(req.query.longitude),
      }
      : viewerProfile?.location?.coordinates) || null;

  // 8. Fetch candidate profiles (up to 40 candidates to rank by shared interests)
  const candidateProfiles = await Profile.find(filter)
    .sort({ completeness: -1, publishedAt: -1 })
    .limit(40)
    .lean();

  if (!candidateProfiles.length) {
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          cards: [],
          totalReturned: 0,
          limit,
          hasMore: false,
          targetGender,
          targetReligion,
        },
        "No matching profiles found"
      )
    );
  }

  const candidateUserIds = candidateProfiles.map((p) => p.userId);

  // 9. Batch fetch Users and ProfilePhotos in parallel
  const [users, photos] = await Promise.all([
    User.find({
      _id: { $in: candidateUserIds },
      accountStatus: ACCOUNT_STATUS.ACTIVE,
    })
      .select("fullName isVerified lastActiveAt")
      .lean(),
    ProfilePhoto.find({
      userId: { $in: candidateUserIds },
      isApproved: true,
      visibility: VISIBILITY.PUBLIC,
    })
      .select("userId url isPrimary")
      .lean(),
  ]);

  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const photoMap = new Map();
  for (const photo of photos) {
    const uid = String(photo.userId);
    if (!photoMap.has(uid)) photoMap.set(uid, []);
    photoMap.get(uid).push(photo);
  }

  // 10. Format and score candidates
  let formattedCards = candidateProfiles
    .map((profile) => {
      const uid = String(profile.userId);
      const user = userMap.get(uid);
      if (!user) return null; // Inactive or deleted user

      const userPhotos = photoMap.get(uid) || [];
      return buildSwipeCard({
        profile,
        user,
        photos: userPhotos,
        viewerInterests,
        viewerCoords,
      });
    })
    .filter(Boolean);

  // 11. Distance Filter (if maxDistanceKm requested via query)
  const maxDistanceKm = Number(req.query.maxDistanceKm || req.query.distance);

  if (Number.isFinite(maxDistanceKm) && maxDistanceKm > 0) {
    formattedCards = formattedCards.filter(
      (c) => c.distanceKm === null || c.distanceKm <= maxDistanceKm
    );
  }

  // 12. Rank candidates:
  // Most shared interests first -> highest match score -> highest completeness
  formattedCards.sort((a, b) => {
    if (b.sharedCount !== a.sharedCount) {
      return b.sharedCount - a.sharedCount;
    }
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    return b.completeness - a.completeness;
  });

  // 13. Slice to desired limit (default: 3 cards)
  const finalCards = formattedCards.slice(0, limit);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        cards: finalCards,
        totalReturned: finalCards.length,
        limit,
        hasMore: formattedCards.length > finalCards.length,
        viewerGender,
        targetGender,
        targetReligion,
      },
      "Swipe cards retrieved successfully"
    )
  );
});


export const handleSwipeAction = asyncHandler(async (req, res) => {
  const viewerId = req.user._id;
  const { action, targetUserId } = req.body;

  if (!action) {
    throw new ApiError(400, "Action is required ('pass', 'like', 'undo')");
  }

  // ===================== ACTION: PASS (Cross icon) =====================
  if (action === "pass") {
    if (!targetUserId) throw new ApiError(400, "targetUserId is required");

    await Pass.updateOne(
      { passerId: viewerId, passedUserId: targetUserId },
      { $set: { passerId: viewerId, passedUserId: targetUserId } },
      { upsert: true }
    );

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          action: "pass",
          targetUserId,
        },
        "Profile passed successfully"
      )
    );
  }

  // ========== ACTION: LIKE (Make Friend / Heart) =========
  if (action === "like") {
    if (!targetUserId) throw new ApiError(400, "targetUserId is required");
    if (String(targetUserId) === String(viewerId)) {
      throw new ApiError(400, "Cannot like yourself");
    }

    const entitlements = await getEntitlements(viewerId);

    // Check daily like counter
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const alreadyLiked = Boolean(
      await Like.exists({ fromUserId: viewerId, toUserId: targetUserId })
    );

    const usedToday = await Like.countDocuments({
      fromUserId: viewerId,
      createdAt: { $gte: today },
    });

    if (!alreadyLiked && usedToday >= entitlements.maxLikesPerDay) {
      throw new ApiError(
        429,
        `Daily like limit reached (${entitlements.maxLikesPerDay}). Upgrade plan for unlimited likes.`
      );
    }

    // Save Like
    await Like.findOneAndUpdate(
      { fromUserId: viewerId, toUserId: targetUserId },
      { $setOnInsert: { fromUserId: viewerId, toUserId: targetUserId, status: "pending" } },
      { upsert: true }
    );

    // Check mutual like -> automatic match
    const mutual = await Like.findOne({
      fromUserId: targetUserId,
      toUserId: viewerId,
    });

    let match = null;
    let isMatch = false;

    if (mutual) {
      match = await ensureMatch(viewerId, targetUserId);
      isMatch = true;
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          action: "like",
          targetUserId,
          isMatch,
          matchId: match?._id || null,
          conversationId: match?.conversationId || null,
        },
        isMatch ? "🎉 It's a Match!" : "Like sent successfully"
      )
    );
  }

  // ===================== ACTION: UNDO / PREVIOUS (Rewind icon) =====================
  if (action === "undo") {
    // Find the most recently passed profile
    const lastPass = await Pass.findOne({ passerId: viewerId }).sort({
      createdAt: -1,
    });

    if (!lastPass) {
      throw new ApiError(400, "No previous passed profile to rewind");
    }

    const rewoundUserId = lastPass.passedUserId;

    // Remove the pass so the user is un-passed
    await Pass.deleteOne({ _id: lastPass._id });

    // Fetch the rewound profile to return its full card for immediate render
    const [rewoundUser, rewoundProfile, photos] = await Promise.all([
      User.findById(rewoundUserId).select("fullName isVerified lastActiveAt").lean(),
      Profile.findOne({ userId: rewoundUserId }).lean(),
      ProfilePhoto.find({
        userId: rewoundUserId,
        isApproved: true,
        visibility: VISIBILITY.PUBLIC,
      }).select("url isPrimary").lean(),
    ]);

    if (!rewoundProfile) {
      return res.status(200).json(
        new ApiResponse(
          200,
          { action: "undo", rewoundUserId },
          "Previous profile un-passed"
        )
      );
    }

    const viewerProfile = await Profile.findOne({ userId: viewerId }).lean();
    const viewerInterests = flattenInterests(viewerProfile?.interests);

    const rewoundCard = buildSwipeCard({
      profile: rewoundProfile,
      user: rewoundUser,
      photos,
      viewerInterests,
      viewerCoords: viewerProfile?.location?.coordinates || null,
    });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          action: "undo",
          rewoundUserId,
          card: rewoundCard,
        },
        "Previous profile restored to card deck"
      )
    );
  }

  throw new ApiError(400, `Unknown swipe action '${action}'`);
});
