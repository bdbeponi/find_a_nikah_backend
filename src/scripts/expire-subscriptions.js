// Marks subscriptions whose end date has passed.
//   npm run expire-subscriptions      - run from cron, once a day is plenty
//
// Nothing depends on this having run. getEntitlements compares endsAt itself,
// so a lapsed member loses their features the moment they lapse whether or not
// this ever fires. It keeps `status` honest for the admin lists and for the
// unique "one active subscription per member" index.
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../db/index.js";
import { expireFinished } from "../services/payment.service.js";

const run = async () => {
  await connectDB();
  const count = await expireFinished();
  console.log(`✅ marked ${count} subscriptions expired`);
};

run()
  .catch((err) => {
    console.error("❌ expire-subscriptions failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
