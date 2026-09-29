import mongoose, { Schema } from "mongoose";
import { VISIBILITY, VISIBILITIES } from "../constants.js";

const profilePhotoSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // What the browser loads. Absolute when the file went to a bucket, a
    // relative "public/upload/..." path when it went to local disk.
    url: { type: String, required: true },
    // The storage key, kept so the file can be deleted later. A URL can be
    // rewritten by a CDN change; the key cannot.
    storageKey: { type: String },

    isPrimary: { type: Boolean, default: false },

    /**
     * Photos are the thing fake profiles are built from, so a new one is not
     * visible to anybody until a moderator approves it. The member sees their
     * own either way.
     */
    isApproved: { type: Boolean, default: false },
    rejectionReason: { type: String, trim: true },

    // Plenty of members will only show their face to a confirmed match.
    visibility: {
      type: String,
      enum: VISIBILITIES,
      default: VISIBILITY.PUBLIC,
    },

    width: { type: Number },
    height: { type: Number },
    sizeBytes: { type: Number },
  },
  { timestamps: true }
);

profilePhotoSchema.index({ userId: 1, isPrimary: -1, createdAt: 1 });
// The moderation queue
profilePhotoSchema.index({ isApproved: 1, createdAt: 1 });

/**
 * Exactly one primary per member.
 *
 * Done here rather than in the controller because two requests that both set a
 * primary would otherwise both succeed and leave two. This still races in
 * theory - see the ponytail note - but it closes the ordinary case and means
 * no call site can forget.
 */
// ponytail: unsets siblings on save, not in a transaction. Two simultaneous
// "make this primary" calls can still both land; make it a transaction if that
// ever shows up in the data.
profilePhotoSchema.pre("save", async function (next) {
  if (!this.isPrimary || !this.isModified("isPrimary")) return next();

  await this.constructor.updateMany(
    { userId: this.userId, _id: { $ne: this._id } },
    { $set: { isPrimary: false } }
  );
  next();
});

export const ProfilePhoto = mongoose.model("ProfilePhoto", profilePhotoSchema);
