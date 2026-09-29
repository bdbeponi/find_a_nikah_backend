// Builds every index declared in the schemas against the live database.
//   npm run sync-indexes
//
// Mongoose only auto-builds indexes in development, and an index added to a
// schema after a collection already exists is otherwise never created - the
// query just silently goes back to a collection scan.
import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import connectDB from "../db/index.js";
import * as models from "../models/index.js";

const run = async () => {
  await connectDB();

  // The barrel exports helpers next to the models (orderPair, for one), so
  // anything without syncIndexes is skipped rather than ending the run.
  const entries = Object.entries(models).filter(
    ([, value]) => typeof value?.syncIndexes === "function"
  );

  for (const [name, model] of entries) {
    // Drops indexes the schema no longer declares, too, which is the point:
    // a stale unique index is what makes a legitimate write fail with a 409.
    const changes = await model.syncIndexes();
    console.log(`${name}: ${changes.length ? changes.join(", ") : "up to date"}`);
  }
};

run()
  .catch((err) => {
    console.error("❌ sync-indexes failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
