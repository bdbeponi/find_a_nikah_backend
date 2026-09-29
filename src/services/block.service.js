import { Block } from "../models/block.model.js";

/**
 * Every user id that must be filtered out of anything this member sees.
 *
 * Both directions, always. Blocking somebody hides them from you; being blocked
 * has to hide you from them, or the block accomplishes nothing - they would
 * still find the profile, still like it, still appear in the other side's
 * "who liked me". One $or over the two indexed fields, ids only.
 */
export const getBlockedUserIds = async (userId) => {
  const rows = await Block.find({
    $or: [{ blockerId: userId }, { blockedUserId: userId }],
  })
    .select("blockerId blockedUserId")
    .lean();

  const ids = new Set();
  for (const row of rows) {
    const other =
      String(row.blockerId) === String(userId) ? row.blockedUserId : row.blockerId;
    ids.add(String(other));
  }

  return [...ids];
};

/** Whether either of the two has blocked the other. */
export const isBlockedBetween = async (one, two) =>
  Boolean(
    await Block.exists({
      $or: [
        { blockerId: one, blockedUserId: two },
        { blockerId: two, blockedUserId: one },
      ],
    })
  );
