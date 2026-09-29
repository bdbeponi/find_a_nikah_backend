import { Match, orderPair } from "../models/match.model.js";
import { Conversation } from "../models/conversation.model.js";
import { Like } from "../models/like.model.js";
import { notify } from "./notification.service.js";
import { emitToUsers } from "../socket/emit.js";

/**
 * Makes the match, its conversation, and the link between them.
 *
 * Idempotent from end to end, and that is the whole design. There are no
 * transactions here (MongoDB 4.4, standalone), so four writes have to survive a
 * crash between any two of them. Every one of them is an upsert or a
 * set-to-a-fixed-value behind a unique index, so running this twice - which the
 * like endpoint does on purpose after a duplicate - produces exactly the same
 * end state as running it once.
 *
 * The order is the safety mechanism:
 *
 *   1. match         - the fact. Unique on the ordered pair, so a simultaneous
 *                      like from both sides still makes one.
 *   2. conversation  - unique on matchId, so step 1 can be repeated safely
 *   3. link them     - a match without its conversationId is recoverable; a
 *                      conversation pointing at nothing is not
 *   4. mark the likes, then notify - both cosmetic, both re-runnable
 *
 * A crash after step 1 leaves a match with no conversation: visible, and fixed
 * by the next call. The reverse order would leave orphan conversations that
 * nothing points at and nobody ever finds.
 */
export const ensureMatch = async (one, two) => {
  const ordered = orderPair(one, two);

  const match = await Match.findOneAndUpdate(
    { userA: ordered.userA, userB: ordered.userB },
    {
      // userA/userB come from the filter on an insert, so repeating them here
      // would be two writers for one path
      $setOnInsert: { users: ordered.users, matchedAt: new Date() },
      // A pair that matched, unmatched and matched again is the same row
      $set: { status: "active" },
      $unset: { unmatchedBy: 1, unmatchedAt: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const conversation = await Conversation.findOneAndUpdate(
    { matchId: match._id },
    { $setOnInsert: { matchId: match._id, participants: ordered.users } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (String(match.conversationId || "") !== String(conversation._id)) {
    await Match.updateOne(
      { _id: match._id },
      { $set: { conversationId: conversation._id } }
    );
    match.conversationId = conversation._id;
  }

  await Like.updateMany(
    {
      $or: [
        { fromUserId: ordered.userA, toUserId: ordered.userB },
        { fromUserId: ordered.userB, toUserId: ordered.userA },
      ],
    },
    { $set: { status: "matched" } }
  );

  return { match, conversation };
};

/** Tells both sides, over socket and in the notification list. */
export const announceMatch = async ({ match, conversation, names = {} }) => {
  const [a, b] = match.users.map(String);

  await Promise.all([
    notify({
      userId: a,
      type: "match_created",
      title: "It is a match",
      body: names[b] ? `You and ${names[b]} liked each other` : "You have a new match",
      data: { matchId: match._id, conversationId: conversation._id, userId: b },
    }),
    notify({
      userId: b,
      type: "match_created",
      title: "It is a match",
      body: names[a] ? `You and ${names[a]} liked each other` : "You have a new match",
      data: { matchId: match._id, conversationId: conversation._id, userId: a },
    }),
  ]);

  emitToUsers([a, b], "match:new", {
    matchId: match._id,
    conversationId: conversation._id,
  });
};
