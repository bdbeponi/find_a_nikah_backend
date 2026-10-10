import * as faceapi from "face-api.js";
import canvas from "canvas";
import path from "path";

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODEL_PATH = path.join(process.cwd(), "models");
let modelsLoaded = false;

export async function loadFaceModels() {
    if (modelsLoaded) return;
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH);
    modelsLoaded = true;
}

/** Descriptor only. Used for the stored profile photo. */
export async function getFaceDescriptor(imagePath) {
    await loadFaceModels();
    const img = await canvas.loadImage(imagePath);
    const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();
    return detection ? Array.from(detection.descriptor) : null;
}

/**
 * Descriptor plus head pose for a live frame.
 *
 *   yaw        0.5 = looking straight at the camera. Computed as where the nose
 *              tip sits between the two jaw edges, in the UNMIRRORED image:
 *              above 0.5 the nose points to the image's right, which is the
 *              person's LEFT; below 0.5 it points to their right.
 *   faceRatio  face box width / image width. Small = the face is far away.
 *
 * Returns { status: "no_face" | "multiple_faces" } when the frame is unusable.
 */
export async function analyzeFace(imagePath) {
    await loadFaceModels();
    const img = await canvas.loadImage(imagePath);
    const found = await faceapi
        .detectAllFaces(img)
        .withFaceLandmarks()
        .withFaceDescriptors();

    if (found.length === 0) return { status: "no_face" };
    if (found.length > 1) return { status: "multiple_faces" };

    const face = found[0];
    const pts = face.landmarks.positions;
    const nose = pts[30]; // nose tip
    const jawLeftEdge = pts[0]; // jaw point on the image's left
    const jawRightEdge = pts[16]; // jaw point on the image's right
    const yaw = (nose.x - jawLeftEdge.x) / (jawRightEdge.x - jawLeftEdge.x);

    return {
        status: "ok",
        descriptor: Array.from(face.descriptor),
        yaw,
        faceRatio: face.detection.box.width / img.width,
    };
}

export function euclideanDistance(d1, d2) {
    return Math.sqrt(d1.reduce((sum, v, i) => sum + (v - d2[i]) ** 2, 0));
}