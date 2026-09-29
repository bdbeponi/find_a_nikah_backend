import mongoose, { Schema } from "mongoose";
import { MATCH_STATUSES } from "../constants.js";

/**
 * Created when two people have each liked the other.
 *
 * The pair is stored sorted by ObjectId into userA/userB, so (A,B) and (B,A)
 * are the same row and the unique index below can actually prevent a duplicate.
 * Without the sort, both users liking at the same moment creates two matches
 * and they end up in two separate conversations about the same thing.
 *
 * `users` carries the same two ids as an array purely so "my matches" is one
 * indexed lookup rather than an $or over two fields.
 */
const matchSchema = new Schema(
  {
    userA: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userB: { type: Schema.Types.ObjectId, ref: "User", required: true },
    users: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],

    status: { type: String, enum: MATCH_STATUSES, default: "active" },
    matchedAt: { type: Date, default: Date.now },

    // Who pressed unmatch, so the other side can be told it was not them
    unmatchedBy: { type: Schema.Types.ObjectId, ref: "User" },
    unmatchedAt: { type: Date },

    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation" },
  },
  { timestamps: true }
);

matchSchema.index({ userA: 1, userB: 1 }, { unique: true });
matchSchema.index({ users: 1, status: 1, matchedAt: -1 });

/**
 * The canonical (userA, userB, users) for a pair, in the order this schema
 * stores them. Exported so the service and the check script build the key the
 * same way - two sort implementations would eventually disagree.
 */
export const orderPair = (one, two) => {
  const [userA, userB] = [String(one), String(two)].sort();
  return { userA, userB, users: [userA, userB] };
};

// Belt to the braces: a document built without orderPair is still stored sorted
matchSchema.pre("validate", function (next) {
  if (this.userA && this.userB) {
    const ordered = orderPair(this.userA, this.userB);
    this.userA = ordered.userA;
    this.userB = ordered.userB;
    this.users = ordered.users;
  }
  next();
});

export const Match = mongoose.model("Match", matchSchema);
