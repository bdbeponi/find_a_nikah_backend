import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { User } from "../src/models/user.model.js";
import { Profile } from "../src/models/profile.model.js";
import { Like } from "../src/models/like.model.js";
import { Pass } from "../src/models/pass.model.js";
import { Match } from "../src/models/match.model.js";
import { getBlockedUserIds } from "../src/services/block.service.js";
import { ageRangeToDob } from "../src/services/search.service.js";
import { PROFILE_STATUS, MIN_AGE, MAX_AGE } from "../src/constants.js";

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  const viewerId = new mongoose.Types.ObjectId("6ac5e6cb9a4c151759932718");

  // Step 1: getExcludedUserIds
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
  ]);

  const excludedUserIds = Array.from(excludeSet);
  console.log("Excluded user IDs count:", excludedUserIds.length);
  console.log("Excluded user IDs:", excludedUserIds);

  // Step 2: Check candidate profiles matching current filter
  const targetGender = "female";
  const targetReligion = "islam";
  const dobRange = ageRangeToDob(MIN_AGE, MAX_AGE);

  const currentFilter = {
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
    gender: targetGender,
    userId: { $nin: excludedUserIds },
    religion: targetReligion,
    dateOfBirth: dobRange,
  };

  const countCurrent = await Profile.countDocuments(currentFilter);
  console.log("Count with current filter (profileStatus: 'published'):", countCurrent);

  // Check how many female profiles exist with ANY profile status:
  const allFemaleFilter = {
    gender: targetGender,
    userId: { $nin: excludedUserIds },
  };
  const allFemales = await Profile.find(allFemaleFilter).lean();
  console.log("Female profiles excluding already swiped/self count:", allFemales.length);
  console.log("Their statuses:", allFemales.map(p => ({ id: p._id, userId: p.userId, status: p.profileStatus, discoverable: p.isDiscoverable })));

  await mongoose.disconnect();
};

run().catch(console.error);
