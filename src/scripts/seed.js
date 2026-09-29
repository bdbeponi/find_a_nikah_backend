// Creates the first admin so the panel is reachable on a fresh database.
//   npm run seed          insert a super admin
//   npm run seed:clear    remove the seeded admin again
//
// Nothing here is used at runtime.
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../db/index.js";
import { User } from "../models/user.model.js";
import { ROLES } from "../constants.js";

const ADMIN_PHONE = process.env.SEED_ADMIN_PHONE || "01800000000";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "admin123456";

const clear = process.argv.includes("--clear");

const run = async () => {
  await connectDB();

  if (clear) {
    const { deletedCount } = await User.deleteOne({ phone: ADMIN_PHONE });
    console.log(`removed ${deletedCount} seeded admin`);
    return;
  }

  const existing = await User.findOne({ phone: ADMIN_PHONE });
  if (existing) {
    console.log(`admin ${ADMIN_PHONE} already exists - nothing to do`);
    return;
  }

  // Goes through create(), not insertMany(), so the pre-save hook hashes the
  // password. insertMany skips document middleware and would store it plain.
  await User.create({
    fullName: "Super Admin",
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
    gender: "male",
    role: ROLES.SUPER_ADMIN,
  });

  console.log(`✅ admin created — phone ${ADMIN_PHONE}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn(
      "⚠️  SEED_ADMIN_PASSWORD was not set, so the default was used. Change it."
    );
  }
};

run()
  .catch((err) => {
    console.error("❌ seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
