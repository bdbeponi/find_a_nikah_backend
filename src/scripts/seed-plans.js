// Puts the subscription catalogue on a fresh database, so the pricing screen
// and every entitlement check have something real to read.
//   npm run seed:plans
//   npm run seed:plans -- --clear
//
// Idempotent: it upserts on the slug, so running it twice changes nothing and
// re-running it after an edit here updates the plan in place.
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../db/index.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { slugify } from "../utils/slugify.js";

// Prices are in poisha - 100 poisha to the taka. Integers, never floats: see
// the note on the schema.
const PLANS = [
  {
    name: "Free",
    description: "Browse profiles and send a few likes a day.",
    priceMinor: 0,
    durationDays: 3650,
    serial: 0,
    features: {
      maxLikesPerDay: 10,
      canMessageBeforeMatch: false,
      canSeeWhoLikedMe: false,
      canSeeContactDetails: false,
      boostedInSearch: false,
    },
  },
  {
    name: "Premium Monthly",
    description: "See who liked you, message before matching, and more likes.",
    priceMinor: 99900,
    durationDays: 30,
    serial: 1,
    features: {
      maxLikesPerDay: 50,
      canMessageBeforeMatch: true,
      canSeeWhoLikedMe: true,
      canSeeContactDetails: true,
      boostedInSearch: false,
    },
  },
  {
    name: "Premium Quarterly",
    description: "Three months of Premium, and your profile shown first.",
    priceMinor: 249900,
    durationDays: 90,
    serial: 2,
    features: {
      maxLikesPerDay: 100,
      canMessageBeforeMatch: true,
      canSeeWhoLikedMe: true,
      canSeeContactDetails: true,
      boostedInSearch: true,
    },
  },
];

const clear = process.argv.includes("--clear");

const run = async () => {
  await connectDB();

  if (clear) {
    const slugs = PLANS.map((plan) => slugify(plan.name));
    const { deletedCount } = await SubscriptionPlan.deleteMany({
      slug: { $in: slugs },
    });
    console.log(`removed ${deletedCount} seeded plans`);
    return;
  }

  for (const plan of PLANS) {
    const slug = slugify(plan.name);
    await SubscriptionPlan.updateOne(
      { slug },
      { $set: { ...plan, slug, isActive: true } },
      { upsert: true }
    );
    console.log(`✅ ${plan.name} (${slug})`);
  }
};

run()
  .catch((err) => {
    console.error("❌ seed:plans failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
