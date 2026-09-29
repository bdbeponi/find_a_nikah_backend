import mongoose, { Schema } from "mongoose";
import { REPORT_REASONS, REPORT_STATUSES } from "../constants.js";

const reportSchema = new Schema(
  {
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reportedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    reason: { type: String, enum: REPORT_REASONS, required: true },
    description: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: REPORT_STATUSES, default: "open" },

    // Filled by the moderator who closed it
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    resolutionNote: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// The admin queue: oldest open report first
reportSchema.index({ status: 1, createdAt: 1 });
// "how many times has this person been reported", the number that matters most
reportSchema.index({ reportedUserId: 1, status: 1 });
reportSchema.index({ reporterId: 1, createdAt: -1 });

/**
 * One open report per person per target. Without it a single angry member can
 * bury the queue in fifty copies of the same complaint; their history of
 * resolved reports is untouched.
 *
 * Equality, not `$in: ["open", "reviewing"]`: a partial index on MongoDB 4.4 -
 * which is what this deployment runs - only understands equality, $exists,
 * the range operators, $type and $and. $in and $or arrived in 6.0.
 */
// ponytail: covers "open" only, so a duplicate can still be filed while a
// moderator has the first one in "reviewing". Widen to $in once the server is
// on 6.0+, or add a derived boolean if it becomes a real nuisance before then.
reportSchema.index(
  { reporterId: 1, reportedUserId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);

export const Report = mongoose.model("Report", reportSchema);
