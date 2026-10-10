import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";

import { analyzeFace, getFaceDescriptor, euclideanDistance } from "../utils/faceService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { Profile } from "../models/profile.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import { User } from "../models/user.model.js";
import { FaceSession } from "../models/faceSession.model.js";

// Identity
const MATCH_THRESHOLD = 0.6; // front frame vs the profile photo
const SIDE_MATCH_THRESHOLD = 0.75; // turned frames vs the front frame (a turned face scores worse)

// Pose. Tune these by logging `steps` from a few real people.
const FRONT_YAW = { min: 0.4, max: 0.6 };
const TURN_YAW = { left: 0.62, right: 0.38 }; // left needs >= 0.62, right needs <= 0.38
const MIN_CLOSE_FACE_RATIO = 0.3; // face box must be at least 30% of the frame width

const SESSION_TTL_MS = 2 * 60 * 1000;
const STEP_KEYS = ["step1", "step2", "step3"];

/* ------------------------------------------------------------- start */
export const startFaceSession = asyncHandler(async (req, res) => {
    // Close-up first, then the two turns in a random order
    const turns = crypto.randomInt(2) === 0 ? ["left", "right"] : ["right", "left"];
    const challenges = ["front", ...turns];

    const session = await FaceSession.create({
        userId: req.user._id,
        challenges,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    return res.status(201).json(
        new ApiResponse(
            201,
            { sessionId: session._id, challenges, expiresInSeconds: SESSION_TTL_MS / 1000 },
            "Face check started"
        )
    );
});

/* ------------------------------------------------------------ verify */
function poseProblem(challenge, a) {
    if (challenge === "front") {
        if (a.faceRatio < MIN_CLOSE_FACE_RATIO) return "move closer so your face fills the oval.";
        if (a.yaw <= FRONT_YAW.min || a.yaw >= FRONT_YAW.max) return "look straight at the camera.";
    }
    if (challenge === "left" && a.yaw < TURN_YAW.left) return "turn your head further to your left.";
    if (challenge === "right" && a.yaw > TURN_YAW.right) return "turn your head further to your right.";
    return null;
}

export const verifyFace = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const uploaded = STEP_KEYS.map((k) => req.files?.[k]?.[0]);
    const absPath = (f) => path.join(process.cwd(), "public/upload", f.filename);
    let keepFront = false;

    try {
        if (uploaded.some((f) => !f)) {
            throw new ApiError(400, "Three photos are required: step1, step2 and step3.");
        }

        const { sessionId } = req.body;
        if (!mongoose.isValidObjectId(sessionId)) {
            throw new ApiError(400, "A valid sessionId is required. Start the check again.");
        }

        // Single use: flipping `used` in the same query that finds the session
        // means two parallel submissions cannot both pass.
        const session = await FaceSession.findOneAndUpdate(
            { _id: sessionId, userId, used: false, expiresAt: { $gt: new Date() } },
            { $set: { used: true } },
            { new: true }
        );
        if (!session) throw new ApiError(400, "This check has expired or was already used. Start again.");

        const profile = await Profile.findOne({ userId });
        if (!profile?.images?.length) {
            throw new ApiError(400, "Upload at least one profile photo before verifying your face");
        }

        // 1. Every frame must show exactly one face, in the pose the server asked for
        const analyses = [];
        for (let i = 0; i < session.challenges.length; i++) {
            const challenge = session.challenges[i];
            const a = await analyzeFace(absPath(uploaded[i]));
            const label = `Step ${i + 1} (${challenge})`;

            if (a.status === "no_face") throw new ApiError(422, `${label}: no face detected. Keep your face in the oval and in good light.`);
            if (a.status === "multiple_faces") throw new ApiError(422, `${label}: more than one face in the frame.`);

            const problem = poseProblem(challenge, a);
            if (problem) throw new ApiError(422, `${label}: ${problem}`);

            analyses.push({ challenge, ...a });
        }

        // 2. All three must be the same person, and the close-up must be the profile's owner
        const profileDescriptor = await getFaceDescriptor(path.join(process.cwd(), profile.images[0]));
        if (!profileDescriptor) {
            throw new ApiError(422, "No face detected in your main profile photo. Please update it first.");
        }

        const front = analyses[0];
        const distance = euclideanDistance(front.descriptor, profileDescriptor);
        const sideDistances = analyses.slice(1).map((a) => euclideanDistance(a.descriptor, front.descriptor));

        const isMatch = distance < MATCH_THRESHOLD && sideDistances.every((d) => d < SIDE_MATCH_THRESHOLD);

        keepFront = true; // kept as the audit copy; the turned frames are deleted below
        const verification = await ProfileVerification.findOneAndUpdate(
            { userId, documentType: "face" },
            {
                $set: {
                    documentUrl: `/public/upload/${uploaded[0].filename}`,
                    status: isMatch ? "approved" : "rejected",
                    rejectionReason: isMatch
                        ? undefined
                        : `Live check did not match profile photo (front ${distance.toFixed(3)}, sides ${sideDistances.map((d) => d.toFixed(3)).join("/")})`,
                    reviewedAt: new Date(),
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        if (isMatch) {
            await User.findByIdAndUpdate(userId, { isVerified: true, verifiedAt: new Date() });
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    isFaceVerified: isMatch,
                    distance,
                    steps: analyses.map((a, i) => ({
                        challenge: a.challenge,
                        yaw: Number(a.yaw.toFixed(3)),
                        faceRatio: Number(a.faceRatio.toFixed(3)),
                        distanceToFront: i === 0 ? null : Number(sideDistances[i - 1].toFixed(3)),
                    })),
                    verification,
                },
                isMatch ? "Face verified successfully" : "Your face did not match your profile photo"
            )
        );
    } finally {
        // Frames are deleted whatever happened; only the front shot of a decided check stays.
        await Promise.all(
            uploaded.map((f, i) =>
                f && !(i === 0 && keepFront) ? fs.unlink(absPath(f)).catch(() => { }) : null
            )
        );
    }
});