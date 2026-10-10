import mongoose, { Schema } from "mongoose";

/**
 * One face check in progress. The server picks the poses and their order, so a
 * client cannot replay frames it prepared earlier: it has to produce exactly
 * these poses, for this session, once, within two minutes.
 *
 * Register this in models/index.js alongside the other models.
 */
const faceSessionSchema = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        challenges: [{ type: String, enum: ["front", "left", "right"] }],
        used: { type: Boolean, default: false },
        // TTL index: Mongo deletes the row once this moment has passed
        expiresAt: { type: Date, required: true, index: { expires: 0 } },
    },
    { timestamps: true }
);

export const FaceSession = mongoose.model("FaceSession", faceSessionSchema);