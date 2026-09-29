import { AuditLog } from "../models/auditLog.model.js";

/**
 * Records what a staff member did.
 *
 * Never throws. An audit write that fails must not undo the action it was
 * describing - a moderator seeing "suspend failed" for an account that is in
 * fact suspended would suspend it again, and the second attempt tells them
 * nothing new. The miss is logged to stderr so it is still visible.
 *
 * That trade is only acceptable because this deployment has no transactions
 * (MongoDB 4.4, standalone - see the note in README). With one we would write
 * the action and its log together or not at all.
 */
export const recordAudit = async ({
  actor,
  action,
  targetType,
  targetId,
  before,
  after,
  note,
  ip,
}) => {
  try {
    await AuditLog.create({
      actorId: actor._id,
      actorRole: actor.role,
      action,
      targetType,
      targetId,
      before,
      after,
      note,
      ip,
    });
  } catch (err) {
    console.error(
      `⚠️  audit write failed for ${action} on ${targetType}:${targetId} -`,
      err.message
    );
  }
};

/**
 * Only the fields that actually changed, for the before/after pair.
 *
 * Whole documents are never stored: a profile's before/after would copy
 * someone's identity details into a second collection that outlives their
 * account, and the log is meant to say what a moderator did, not to be a
 * shadow copy of the site.
 */
export const diff = (before, after, fields) => {
  const from = {};
  const to = {};

  for (const field of fields) {
    const was = before?.[field];
    const now = after?.[field];
    if (String(was) !== String(now)) {
      from[field] = was;
      to[field] = now;
    }
  }

  return { before: from, after: to };
};
