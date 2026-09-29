import fs from "node:fs/promises";
import path from "node:path";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { requireString } from "../utils/requireString.js";
import { Profile } from "../models/profile.model.js";
import { Education } from "../models/education.model.js";
import { Profession } from "../models/profession.model.js";
import { Family } from "../models/family.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import {
  MAX_AGE,
  MIN_AGE,
  PROFILE_STATUS,
  UPLOAD_DIR,
  VERIFICATION_DOC_TYPES,
} from "../constants.js";

// Six is what the photo grid shows. A cap has to exist somewhere, or one member
// uploads four hundred and the disk is theirs.
const MAX_PHOTOS = 6;

/**
 * How finished a profile looks, 0-100.
 *
 * Pure, and exported, because it is the number the "complete your profile"
 * nudge and the recommendation ranking both read - a drift between what the
 * member is told and what the ranking uses would be invisible and permanent.
 * The weights are a judgement, not a fact: photos and the written introduction
 * are what actually gets a profile answered.
 */
export const computeCompleteness = ({
  profile,
  educationCount = 0,
  professionCount = 0,
  family,
  preference,
  photoCount = 0,
} = {}) => {
  if (!profile) return 0;

  const parts = [
    [20, Boolean(profile.dateOfBirth && profile.maritalStatus && profile.religion)],
    [10, Boolean(profile.heightCm)],
    [10, Boolean(profile.city)],
    [15, Boolean(profile.aboutMe && String(profile.aboutMe).trim().length >= 50)],
    [15, photoCount > 0],
    [10, educationCount > 0],
    [10, professionCount > 0],
    [5, Boolean(family)],
    [5, Boolean(preference)],
  ];

  return parts.reduce((total, [weight, done]) => total + (done ? weight : 0), 0);
};

/**
 * The profile fields a member may set on themselves.
 *
 * An allow-list, not a spread of req.body. `profileStatus`, `publishedAt`,
 * `completeness` and `userId` all live on this document, and a body straight
 * into an update is how a member publishes their own profile past moderation.
 * `gender` is absent on purpose: it is fixed at signup, and flipping it would
 * move somebody between the two halves of every search.
 */
export const pickProfileFields = (body = {}) => {
  const allowed = [
    "dateOfBirth",
    "heightCm",
    "maritalStatus",
    "religion",
    "sect",
    "religiousness",
    "city",
    "country",
    "aboutMe",
    "motherTongue",
    "nationality",
  ];

  const out = {};
  for (const field of allowed) {
    if (body[field] !== undefined) out[field] = body[field];
  }

  // GeoJSON wants [longitude, latitude], and the two arrive from the client as
  // named numbers precisely so nobody has to remember which order that is.
  const { longitude, latitude } = body;
  if (longitude !== undefined && latitude !== undefined) {
    const lng = Number(longitude);
    const lat = Number(latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      out.location = { type: "Point", coordinates: [lng, lat] };
    }
  }

  return out;
};

/** Refuses a date of birth that is missing, unparseable or out of range. */
export const checkDateOfBirth = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date of birth is not a valid date";

  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) age -= 1;

  if (age < MIN_AGE) return `You must be at least ${MIN_AGE} to use this service`;
  if (age > MAX_AGE) return "Please check the date of birth";
  return null;
};

/** Recomputes and stores completeness. Cheap, and always after a write. */
const refreshCompleteness = async (userId) => {
  const [profile, educationCount, professionCount, family, preference, photoCount] =
    await Promise.all([
      Profile.findOne({ userId }),
      Education.countDocuments({ userId }),
      Profession.countDocuments({ userId }),
      Family.findOne({ userId }).lean(),
      PartnerPreference.findOne({ userId }).lean(),
      ProfilePhoto.countDocuments({ userId }),
    ]);

  if (!profile) return 0;

  const completeness = computeCompleteness({
    profile,
    educationCount,
    professionCount,
    family,
    preference,
    photoCount,
  });

  await Profile.updateOne({ userId }, { $set: { completeness } });
  return completeness;
};

/** GET /api/v1/profile/me - everything the edit screen needs, in one call. */
const getMyProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [profile, education, profession, family, preference, photos, verification] =
    await Promise.all([
      Profile.findOne({ userId }),
      Education.find({ userId }).sort({ yearOfPassing: -1 }),
      Profession.find({ userId }).sort({ isCurrent: -1, fromYear: -1 }),
      Family.findOne({ userId }),
      PartnerPreference.findOne({ userId }),
      ProfilePhoto.find({ userId }).sort({ isPrimary: -1, createdAt: 1 }),
      ProfileVerification.findOne({ userId }).sort({ createdAt: -1 }),
    ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: req.user,
        profile,
        education,
        profession,
        family,
        preference,
        photos,
        verification,
      },
      profile ? "Your profile" : "No profile yet"
    )
  );
});

/**
 * PUT /api/v1/profile/me - creates it the first time, updates it after.
 *
 * One endpoint rather than POST-then-PATCH: the mobile app's form is the same
 * screen either way, and a client that has to know whether a profile already
 * exists gets it wrong on a retry.
 *
 * Editing the written introduction of a published profile sends it back to the
 * queue. That is the one field a member can use to post a phone number after a
 * moderator has already approved them, and re-reading it is cheap.
 */
const upsertMyProfile = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const fields = pickProfileFields(req.body);
  const existing = await Profile.findOne({ userId });

  if (!existing) {
    for (const required of ["dateOfBirth", "maritalStatus", "religion"]) {
      if (fields[required] === undefined) {
        throw new ApiError(400, `${required} is required to create a profile`);
      }
    }
  }

  if (fields.dateOfBirth !== undefined) {
    const problem = checkDateOfBirth(fields.dateOfBirth);
    if (problem) throw new ApiError(400, problem);
  }

  let requeued = false;

  if (!existing) {
    await Profile.create({
      ...fields,
      userId,
      // From the account, never from the body. See the model's note.
      gender: req.user.gender,
    });
  } else {
    const aboutChanged =
      fields.aboutMe !== undefined &&
      String(fields.aboutMe).trim() !== String(existing.aboutMe || "").trim();

    if (aboutChanged && existing.profileStatus === PROFILE_STATUS.PUBLISHED) {
      fields.profileStatus = PROFILE_STATUS.PENDING;
      requeued = true;
    }

    existing.set(fields);
    await existing.save();
  }

  const completeness = await refreshCompleteness(userId);
  const profile = await Profile.findOne({ userId });

  return res.status(existing ? 200 : 201).json(
    new ApiResponse(
      existing ? 200 : 201,
      { profile, completeness },
      requeued
        ? "Saved. Your introduction changed, so it goes back for review"
        : existing
          ? "Profile updated"
          : "Profile created, it will appear once a moderator approves it"
    )
  );
});

/**
 * PATCH /api/v1/profile/me/discoverable - the member's own pause switch.
 *
 * Separate from profileStatus and separate from the update above, because
 * pausing has to work in one tap and must never be mixed up with a moderation
 * decision. Nothing is deleted: matches and conversations carry on.
 */
const setDiscoverable = asyncHandler(async (req, res) => {
  const { isDiscoverable } = req.body || {};
  if (typeof isDiscoverable !== "boolean") {
    throw new ApiError(400, "isDiscoverable must be true or false");
  }

  const profile = await Profile.findOneAndUpdate(
    { userId: req.user._id },
    { $set: { isDiscoverable } },
    { new: true }
  );

  if (!profile) throw new ApiError(404, "Create your profile first");

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        profile,
        isDiscoverable ? "You are visible again" : "You are hidden from search"
      )
    );
});

// ------------------------------------------------------ education, profession
// Both are many-per-member and behave identically, so one set of handlers is
// built for each collection rather than two near-identical files.

const ownedList = (Model, sort) =>
  asyncHandler(async (req, res) => {
    const rows = await Model.find({ userId: req.user._id }).sort(sort);
    return res.status(200).json(new ApiResponse(200, rows, "List"));
  });

const ownedCreate = (Model, fields, label) =>
  asyncHandler(async (req, res) => {
    const doc = {};
    for (const field of fields) {
      if (req.body?.[field] !== undefined) doc[field] = req.body[field];
    }

    const row = await Model.create({ ...doc, userId: req.user._id });
    await refreshCompleteness(req.user._id);

    return res.status(201).json(new ApiResponse(201, row, `${label} added`));
  });

const ownedUpdate = (Model, fields, label) =>
  asyncHandler(async (req, res) => {
    const doc = {};
    for (const field of fields) {
      if (req.body?.[field] !== undefined) doc[field] = req.body[field];
    }

    // userId is in the filter, not checked afterwards: a findById followed by
    // an ownership check is two round trips and one forgotten check away from
    // letting anybody edit anybody's row.
    const row = await Model.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: doc },
      { new: true, runValidators: true }
    );

    if (!row) throw new ApiError(404, `${label} not found`);

    return res.status(200).json(new ApiResponse(200, row, `${label} updated`));
  });

const ownedDelete = (Model, label) =>
  asyncHandler(async (req, res) => {
    const row = await Model.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!row) throw new ApiError(404, `${label} not found`);
    await refreshCompleteness(req.user._id);

    return res.status(200).json(new ApiResponse(200, null, `${label} removed`));
  });

const EDUCATION_FIELDS = [
  "degree",
  "institution",
  "fieldOfStudy",
  "yearOfPassing",
  "grade",
];

const PROFESSION_FIELDS = [
  "occupation",
  "designation",
  "company",
  "workCity",
  "monthlyIncome",
  "incomeVisibility",
  "isCurrent",
  "fromYear",
  "toYear",
];

const listEducation = ownedList(Education, { yearOfPassing: -1 });
const addEducation = ownedCreate(Education, EDUCATION_FIELDS, "Education");
const updateEducation = ownedUpdate(Education, EDUCATION_FIELDS, "Education");
const removeEducation = ownedDelete(Education, "Education");

const listProfession = ownedList(Profession, { isCurrent: -1, fromYear: -1 });
const addProfession = ownedCreate(Profession, PROFESSION_FIELDS, "Profession");
const updateProfession = ownedUpdate(Profession, PROFESSION_FIELDS, "Profession");
const removeProfession = ownedDelete(Profession, "Profession");

// ----------------------------------------------------------- one per member
// Family and preferences are PUT, not POST: there is exactly one of each, and
// the client should not have to know whether it exists yet.

const FAMILY_FIELDS = [
  "fatherName",
  "fatherOccupation",
  "fatherAlive",
  "motherName",
  "motherOccupation",
  "motherAlive",
  "brothers",
  "marriedBrothers",
  "sisters",
  "marriedSisters",
  "familyType",
  "familyStatus",
  "homeDistrict",
  "familyDetails",
];

const PREFERENCE_FIELDS = [
  "ageRange",
  "heightRange",
  "preferredReligions",
  "preferredSects",
  "preferredReligiousness",
  "maritalStatuses",
  "preferredCities",
  "preferredCountries",
  "preferredEducation",
  "preferredOccupations",
  "minMonthlyIncome",
  "willingToRelocate",
  "verifiedOnly",
];

/**
 * A single-document upsert.
 *
 * `save()` rather than findOneAndUpdate with upsert, because both schemas carry
 * a pre("validate") hook - "married brothers cannot exceed brothers", "min
 * cannot exceed max" - and an update pipeline runs neither.
 */
const soleUpsert = (Model, fields, label) =>
  asyncHandler(async (req, res) => {
    const doc =
      (await Model.findOne({ userId: req.user._id })) ||
      new Model({ userId: req.user._id });

    for (const field of fields) {
      if (req.body?.[field] !== undefined) doc[field] = req.body[field];
    }

    await doc.save();
    await refreshCompleteness(req.user._id);

    return res.status(200).json(new ApiResponse(200, doc, `${label} saved`));
  });

const soleGet = (Model) =>
  asyncHandler(async (req, res) => {
    const doc = await Model.findOne({ userId: req.user._id });
    return res.status(200).json(new ApiResponse(200, doc, doc ? "Found" : "Not set"));
  });

const getFamily = soleGet(Family);
const saveFamily = soleUpsert(Family, FAMILY_FIELDS, "Family details");

const getPreference = soleGet(PartnerPreference);
const savePreference = soleUpsert(
  PartnerPreference,
  PREFERENCE_FIELDS,
  "Partner preferences"
);

// ------------------------------------------------------------------- photos

/** GET /api/v1/profile/me/photos - the member sees their own, approved or not. */
const listMyPhotos = asyncHandler(async (req, res) => {
  const photos = await ProfilePhoto.find({ userId: req.user._id }).sort({
    isPrimary: -1,
    createdAt: 1,
  });

  return res.status(200).json(new ApiResponse(200, photos, "Your photos"));
});

/**
 * POST /api/v1/profile/me/photos
 *
 * Arrives already resized and converted by the multer engine. It is stored
 * unapproved: photos are what a fake profile is built out of, so nobody else
 * sees it until a moderator has.
 */
const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "An image file is required");

  const count = await ProfilePhoto.countDocuments({ userId: req.user._id });
  if (count >= MAX_PHOTOS) {
    // The file is already on disk by the time we get here, so it has to go.
    await fs.unlink(req.file.path).catch(() => {});
    throw new ApiError(409, `You can keep at most ${MAX_PHOTOS} photos`);
  }

  const photo = await ProfilePhoto.create({
    userId: req.user._id,
    url: `${UPLOAD_DIR}/${req.file.filename}`,
    storageKey: req.file.filename,
    sizeBytes: req.file.size,
    // The first one is the primary, otherwise a new member has photos and no
    // picture on their card.
    isPrimary: count === 0,
    visibility: req.body?.visibility,
  });

  await refreshCompleteness(req.user._id);

  return res
    .status(201)
    .json(new ApiResponse(201, photo, "Uploaded, waiting for review"));
});

/** PATCH /api/v1/profile/me/photos/:id/primary */
const setPrimaryPhoto = asyncHandler(async (req, res) => {
  const photo = await ProfilePhoto.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!photo) throw new ApiError(404, "Photo not found");

  photo.isPrimary = true;
  // The pre-save hook clears the others.
  await photo.save();

  return res.status(200).json(new ApiResponse(200, photo, "Primary photo set"));
});

/** PATCH /api/v1/profile/me/photos/:id - visibility only. */
const setPhotoVisibility = asyncHandler(async (req, res) => {
  const photo = await ProfilePhoto.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { $set: { visibility: requireString(req.body?.visibility, "Visibility") } },
    { new: true, runValidators: true }
  );

  if (!photo) throw new ApiError(404, "Photo not found");

  return res.status(200).json(new ApiResponse(200, photo, "Visibility updated"));
});

/**
 * DELETE /api/v1/profile/me/photos/:id
 *
 * The row goes first and the file second. The other order leaves a deleted file
 * with a live row pointing at it - a broken image on the profile - where this
 * one leaves at worst an orphan file nobody can reach.
 */
const removePhoto = asyncHandler(async (req, res) => {
  const photo = await ProfilePhoto.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!photo) throw new ApiError(404, "Photo not found");

  if (photo.storageKey) {
    await fs
      .unlink(path.join(process.cwd(), UPLOAD_DIR, photo.storageKey))
      .catch(() => {});
  }

  // Deleting the primary must not leave a member with photos and no picture.
  if (photo.isPrimary) {
    const next = await ProfilePhoto.findOne({ userId: req.user._id }).sort({
      createdAt: 1,
    });
    if (next) {
      next.isPrimary = true;
      await next.save();
    }
  }

  await refreshCompleteness(req.user._id);

  return res.status(200).json(new ApiResponse(200, null, "Photo removed"));
});

// -------------------------------------------------------------- verification

/**
 * POST /api/v1/profile/me/verification
 *
 * Uploads an identity document. The unique partial index allows one pending
 * request per member; a second one is refused here with a readable message
 * rather than as an E11000.
 */
const submitVerification = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, "A photo of the document is required");

  const documentType = String(req.body?.documentType || "").trim();

  const refuse = async (status, message) => {
    await fs.unlink(req.file.path).catch(() => {});
    throw new ApiError(status, message);
  };

  if (!VERIFICATION_DOC_TYPES.includes(documentType)) {
    await refuse(
      400,
      `Document type must be one of: ${VERIFICATION_DOC_TYPES.join(", ")}`
    );
  }

  if (req.user.isVerified) {
    await refuse(409, "Your account is already verified");
  }

  const pending = await ProfileVerification.findOne({
    userId: req.user._id,
    status: "pending",
  });

  if (pending) {
    await refuse(409, "You already have a request waiting for review");
  }

  const request = await ProfileVerification.create({
    userId: req.user._id,
    documentType,
    documentUrl: `${UPLOAD_DIR}/${req.file.filename}`,
    documentStorageKey: req.file.filename,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, request, "Submitted for review"));
});

/** GET /api/v1/profile/me/verification - the latest request and its answer. */
const getMyVerification = asyncHandler(async (req, res) => {
  const request = await ProfileVerification.findOne({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .lean();

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { isVerified: req.user.isVerified, request },
        request ? "Latest request" : "Nothing submitted"
      )
    );
});

export {
  getMyProfile,
  upsertMyProfile,
  setDiscoverable,
  listEducation,
  addEducation,
  updateEducation,
  removeEducation,
  listProfession,
  addProfession,
  updateProfession,
  removeProfession,
  getFamily,
  saveFamily,
  getPreference,
  savePreference,
  listMyPhotos,
  uploadPhoto,
  setPrimaryPhoto,
  setPhotoVisibility,
  removePhoto,
  submitVerification,
  getMyVerification,
  refreshCompleteness,
  MAX_PHOTOS,
};
