import mongoose, { Schema } from "mongoose";

/**
 * Who did what, to whom, as an admin.
 *
 * Append-only: nothing in the application updates or deletes a row here, and
 * no TTL index removes them. The whole value of the log is that it cannot be
 * quietly tidied up by the person it would incriminate - a suspended member
 * asking why needs an answer, and so does a moderator accused of acting out of
 * turn.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true },

    // "user.suspend", "report.resolve", "verification.reject"
    action: { type: String, required: true, trim: true, maxlength: 120 },

    targetType: { type: String, trim: true, maxlength: 60 },
    targetId: { type: Schema.Types.ObjectId },

    // Only the fields that changed, not whole documents - a full before/after
    // of a profile would copy someone's identity documents into a second place.
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },

    note: { type: String, trim: true, maxlength: 1000 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
