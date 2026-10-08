import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { requireString } from "../utils/requireString.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import { cookieOptions, issueTokens } from "../services/auth.service.js";
import { deliverOtp, issueOtp, verifyOtp } from "../services/otp.service.js";
import { generateAiBioForUser } from "../services/ai.service.js";
import {
  ACCOUNT_STATUS,
  ACCOUNT_TYPES,
  FAITH,
  GENDERS,
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  KNOW_DURATIONS,
  MARRIAGE_TIMELINES,
  MAX_AGE,
  MIN_AGE,
  ONBOARDING_INTENTS,
  PROFILE_FOR,
  PROFILE_STATUS,
  REFERRAL_SOURCES,
  RELIGIONS,
  RELIGIOUS_PRACTICES,
  ROLES,
} from "../constants.js";
import { computeCompleteness } from "./profile.controllers.js";

const clientInfo = (req) => ({
  userAgent: req.headers["user-agent"]?.slice(0, 400),
  ip: req.ip,
});

const withTokens = (res, status, { accessToken, refreshToken }, data, message) =>
  res
    .status(status)
    .cookie("accessToken", accessToken, cookieOptions())
    .cookie("refreshToken", refreshToken, cookieOptions())
    .json(new ApiResponse(status, { ...data, accessToken, refreshToken }, message));

/**
 * Flexible Date parser.
 * Handles "YYYY-MM-DD", "DD-MM-YYYY", "03 Feb 1998", common typos ("fed" -> "feb"), etc.
 */
export const parseDateOfBirth = (val) => {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val;
  if (typeof val === "string") {
    let clean = val.trim();
    // Common typo correction: "fed" -> "feb"
    clean = clean.replace(/\bfed\b/i, "feb");

    // Direct JS Date parse
    let d = new Date(clean);
    if (!Number.isNaN(d.getTime())) return d;

    // DD-MM-YYYY or DD/MM/YYYY
    const m = clean.match(/^(\d{1,2})[-/.\s]+(\d{1,2})[-/.\s]+(\d{4})$/);
    if (m) {
      d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
};

/**
 * Flexible language parser.
 * Handles arrays, comma-separated strings, or single string.
 */
const parseLanguages = (val) => {
  if (Array.isArray(val)) return val.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof val === "string" && val.trim()) {
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["English"];
};

/**
 * Flexible Height parser.
 * Handles pure numbers (145), cm strings ("145cm", "145cm  4'9\"", "124cm  4.1"),
 * and feet/inches strings ("5'9\"", "5.9").
 */
export const parseHeightCm = (val) => {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
  if (typeof val === "string") {
    const str = val.trim();
    // 1. If it contains "cm" (e.g. "145cm  4'9\"", "124cm  4.1", "150 cm")
    const cmMatch = str.match(/(\d{2,3})\s*cm/i);
    if (cmMatch) return parseInt(cmMatch[1], 10);

    // 2. Pure or leading cm number >= 100
    const leadingNumberMatch = str.match(/^(\d{2,3})/);
    if (leadingNumberMatch && parseInt(leadingNumberMatch[1], 10) >= 100) {
      return parseInt(leadingNumberMatch[1], 10);
    }

    // 3. Feet and inches (e.g. "5'9\"", "5'9", "5 ft 9 in")
    const ftInMatch = str.match(/^(\d)['`’ft.\s]+(\d{1,2})?["in\s]*$/i);
    if (ftInMatch) {
      const feet = parseInt(ftInMatch[1], 10);
      const inches = ftInMatch[2] ? parseInt(ftInMatch[2], 10) : 0;
      return Math.round((feet * 12 + inches) * 2.54);
    }

    const anyNum = parseInt(str, 10);
    if (Number.isFinite(anyNum)) return anyNum;
  }
  return null;
};

/**
 * STEP 1: POST /api/v1/onboarding/email/send-code
 * Send email verification OTP
 */
export const sendEmailOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const targetEmail = requireString(email, "Email").toLowerCase();

  const existing = await User.findOne({
    email: targetEmail,
    accountStatus: ACCOUNT_STATUS.ACTIVE,
    isOnboardingComplete: true,
  });

  if (existing) {
    throw new ApiError(409, "An account with this email already exists");
  }

  const code = await issueOtp(targetEmail, "email_verification");
  const devCode = await deliverOtp(targetEmail, code, "email_verification");

  return res.status(200).json(
    new ApiResponse(200, { devCode }, "Verification code sent to your email")
  );
});

/**
 * STEP 2: POST /api/v1/onboarding/email/verify-code
 * Verify the OTP received via email
 */
export const verifyEmailOtp = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  const targetEmail = requireString(email, "Email").toLowerCase();
  const targetCode = requireString(code, "Verification code");

  await verifyOtp(targetEmail, "email_verification", targetCode);

  return res.status(200).json(
    new ApiResponse(200, { email: targetEmail, verified: true }, "Email verified successfully")
  );
});

/**
 * STEP 3: POST /api/v1/onboarding/account
 * Create account with email & password after verification
 */
export const registerAccount = asyncHandler(async (req, res) => {
  const { email, password, confirmPassword } = req.body;
  const targetEmail = requireString(email, "Email").toLowerCase();

  if (typeof password !== "string" || password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }

  if (confirmPassword && password !== confirmPassword) {
    throw new ApiError(400, "Password and confirm password do not match");
  }

  let user = await User.findOne({ email: targetEmail });
  if (user && user.isOnboardingComplete) {
    throw new ApiError(409, "An account with this email already exists. Please log in.");
  }

  if (!user) {
    user = await User.create({
      fullName: targetEmail.split("@")[0] || "New Member",
      email: targetEmail,
      password,
      role: ROLES.MEMBER,
      isEmailVerified: true,
      onboardingStep: 4,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
    });
  } else {
    user.password = password;
    user.isEmailVerified = true;
    user.onboardingStep = Math.max(user.onboardingStep || 1, 4);
    await user.save();
  }

  const tokens = await issueTokens(user, clientInfo(req));

  return withTokens(
    res,
    201,
    tokens,
    {
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        onboardingStep: user.onboardingStep,
        isOnboardingComplete: user.isOnboardingComplete,
      },
    },
    "Account created. Proceed to profile details."
  );
});

/**
 * GET /api/v1/onboarding/status
 * Fetches current onboarding progress and existing answers
 */
export const getOnboardingStatus = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [user, profile, preference, photos, verifications] = await Promise.all([
    User.findById(userId).select("fullName email phone gender onboardingStep isOnboardingComplete isPhoneVerified isEmailVerified"),
    Profile.findOne({ userId }).lean(),
    PartnerPreference.findOne({ userId }).lean(),
    ProfilePhoto.find({ userId }).select("url isPrimary isApproved visibility").lean(),
    ProfileVerification.find({ userId }).select("documentType status").lean(),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user,
        profile,
        preference,
        photos,
        verifications,
        currentStep: user?.onboardingStep || profile?.onboardingStep || 4,
        isCompleted: Boolean(user?.isOnboardingComplete && profile?.isOnboardingCompleted),
      },
      "Onboarding status"
    )
  );
});


export const getAiGeneratedBio = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const tone = req.query.tone || req.body.tone || "balanced";
  const keywords = req.query.keywords || req.body.keywords || "";

  const result = await generateAiBioForUser(userId, { tone, keywords });

  return res.status(200).json(
    new ApiResponse(
      200,
      result,
      "AI bio generated successfully"
    )
  );
});


export const saveOnboardingStep = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Accept data whether passed nested in req.body.data OR flat in req.body
  const payload =
    req.body?.data && typeof req.body.data === "object"
      ? { ...req.body, ...req.body.data }
      : req.body || {};

  const stepNumber = Number(payload.step);
  if (!Number.isInteger(stepNumber) || stepNumber < 4 || stepNumber > 27) {
    throw new ApiError(400, "Step must be an integer between 4 and 27");
  }

  const nextStep = Math.min(stepNumber + 1, 27);
  let user = await User.findById(userId);
  let profile = await Profile.findOne({ userId });

  // Handle skip action
  if (payload.isSkip) {
    if (user && (user.onboardingStep || 1) <= stepNumber) {
      user.onboardingStep = nextStep;
      await user.save({ validateBeforeSave: false });
    }
    if (profile && (profile.onboardingStep || 1) <= stepNumber) {
      profile.onboardingStep = nextStep;
      await profile.save({ validateBeforeSave: false });
    }
    return res.status(200).json(
      new ApiResponse(200, { step: nextStep, skipped: true }, `Step ${stepNumber} skipped`)
    );
  }

  // Common profile fields accumulator
  const profileUpdates = { onboardingStep: nextStep };
  let aiBioResult = null;


  // console.log("payload.profileFor", payload.profileFor)

  switch (stepNumber) {
    case 4: {
      // Step 4: Individual or family account & core demographics
      const accountType = payload.accountType || "individual";
      if (!ACCOUNT_TYPES.includes(accountType)) {
        throw new ApiError(400, `accountType must be one of: ${ACCOUNT_TYPES.join(", ")}`);
      }

      let profileFor = payload.profileFor;
      if (accountType === "family") {
        if (!profileFor || !PROFILE_FOR.includes(profileFor)) {
          throw new ApiError(
            400,
            `profileFor is required for family accounts and must be one of: ${PROFILE_FOR.join(", ")}`
          );
        }
      } else {
        // Individual account does not use a family relationship
        profileFor = undefined;
      }

      const gender = payload.gender;

      if (!gender || !GENDERS.includes(gender)) {
        throw new ApiError(400, `Gender must be one of: ${GENDERS.join(", ")}`);
      }

      const religion = payload.religion;
      if (!religion || !RELIGIONS.includes(religion)) {
        throw new ApiError(400, `Religion must be one of: ${RELIGIONS.join(", ")}`);
      }

      // If religion is Islam, validate faith if provided
      let faith = payload.faith || payload.sect;
      if (religion === "islam") {
        if (faith && !FAITH.includes(faith)) {
          throw new ApiError(400, `Faith must be one of: ${FAITH.join(", ")}`);
        }
      } else {
        // Islamic faith practices are not applicable for other religions
        faith = undefined;
      }

      const fullName = requireString(payload.fullName, "Full name");

      // Date of birth parsing & validation
      const rawDob = payload.dateOfBirth;
      const dobDate = parseDateOfBirth(rawDob);
      if (!dobDate) {
        throw new ApiError(
          400,
          "Date of birth is not a valid date. Example: 1998-05-15 or 15 Feb 1998"
        );
      }

      // Age calculation
      const now = new Date();
      let age = now.getFullYear() - dobDate.getFullYear();
      const monthDiff = now.getMonth() - dobDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dobDate.getDate())) age--;

      if (age < MIN_AGE) {
        throw new ApiError(
          400,
          `You must be at least ${MIN_AGE} years old to register. (Year ${dobDate.getFullYear()} is under ${MIN_AGE})`
        );
      }
      if (age > MAX_AGE) {
        throw new ApiError(400, `Age must be under ${MAX_AGE} years old`);
      }

      const languages = parseLanguages(payload.languages);

      // Save to User
      user.fullName = fullName;
      user.gender = gender;
      user.onboardingStep = Math.max(user.onboardingStep || 1, nextStep);
      await user.save({ validateBeforeSave: false });

      // Build Profile update
      const updateSet = {
        accountType,
        profileFor,
        gender,
        dateOfBirth: dobDate,
        religion,
        languages,
        motherTongue: languages[0] || "Bengali",
        onboardingStep: Math.max(profile?.onboardingStep || 1, nextStep),
      };
      if (faith) {
        updateSet.faith = faith;
      }

      // Save to Profile
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: updateSet,
          ...(religion !== "islam" ? { $unset: { faith: "" } } : {}),
        },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      break;
    }

    case 5:
      const intent = payload.intent;
      if (!intent || !ONBOARDING_INTENTS.includes(intent)) {
        throw new ApiError(400, `Intent must be one of: ${ONBOARDING_INTENTS.join(", ")}`);
      }
      profileUpdates.intent = intent;

      break;

    case 6:
      const referralSource = payload.referralSource;
      if (!referralSource || !REFERRAL_SOURCES.includes(referralSource)) {
        throw new ApiError(400, `Referral source must be one of: ${REFERRAL_SOURCES.join(", ")}`);
      }
      profileUpdates.referralSource = referralSource;
      break;

    case 7:
      profileUpdates.nationality = payload.nationality;
      break;

    case 8:
      if (payload.grewUpIn) profileUpdates.grewUpIn = payload.grewUpIn;
      break;

    case 9:
      if (payload.ethnicity) profileUpdates.ethnicity = payload.ethnicity;
      break;

    case 10: {
      const h = parseHeightCm(payload.heightCm);
      if (h === null) {
        throw new ApiError(400, "Height is required (e.g. 145cm or 160)");
      }
      if (h < HEIGHT_CM_MIN || h > HEIGHT_CM_MAX) {
        throw new ApiError(
          400,
          `Height must be between ${HEIGHT_CM_MIN} cm and ${HEIGHT_CM_MAX} cm (received ${h} cm)`
        );
      }
      profileUpdates.heightCm = h;
      break;
    }

    case 11:
      if (payload.educationLevel) profileUpdates.educationLevel = payload.educationLevel;
      break;

    case 12: {
      const title = payload.professionTitle;
      if (title) profileUpdates.professionTitle = title;
      break;
    }

    case 13:
      if (payload.maritalStatus) profileUpdates.maritalStatus = payload.maritalStatus;
      break;

    case 14:
      const getToknowDuration = payload.getToknowDuration;
      const marriageTimeline = payload.marriageTimeline;
      if (getToknowDuration && !KNOW_DURATIONS.includes(getToknowDuration)) {
        throw new ApiError(400, `Get to know duration must be one of: ${KNOW_DURATIONS.join(", ")}`);
      }
      if (marriageTimeline && !MARRIAGE_TIMELINES.includes(marriageTimeline)) {
        throw new ApiError(400, `Marriage timeline must be one of: ${MARRIAGE_TIMELINES.join(", ")}`);
      }

      if (payload.getToknowDuration) {
        profileUpdates["marriageIntentions.getToknowDuration"] = payload.getToknowDuration;
      }
      if (payload.marriageTimeline) {
        profileUpdates["marriageIntentions.marriageTimeline"] = payload.marriageTimeline;
      }
      break;

    case 15: {
      const faith = payload.faith;
      if (faith) {
        if (!FAITH.includes(faith)) {
          throw new ApiError(400, `Faith must be one of: ${FAITH.join(", ")}`);
        }
        profileUpdates.faith = faith;
      }
      break;
    }

    case 16:

      const religiousPractices = payload.religiousPractice;

      if (!RELIGIOUS_PRACTICES.includes(religiousPractices)) {
        throw new ApiError(400, `Religious practice must be one of: ${RELIGIOUS_PRACTICES.join(", ")}`);
      }
      profileUpdates.religiousPractice = religiousPractices;
      break;

    case 17: {
      const raw = payload || {};
      const clean = {}
      const hasValue = (
        typeof raw.halalFood === "boolean" ||
        typeof raw.smoking === "boolean" ||
        typeof raw.alcohol === "boolean"
      );
      if (typeof raw.halalFood === "boolean") clean.halalFood = raw.halalFood;
      if (typeof raw.smoking === "boolean") clean.smoking = raw.smoking;
      if (typeof raw.alcohol === "boolean") clean.alcohol = raw.alcohol;
      if (!hasValue) {
        // If nothing was provided, don't update the whole embedded document
        // to `{}`. Just skip the update.
        break;
      }
      profileUpdates.lifestyle = clean;
      break;
    }

    case 18:
      const raw = payload || {};
      const clean = {}
      const hasValue = (
        typeof raw.bornMuslim === "boolean" ||
        typeof raw.haveChildren === "boolean" ||
        typeof raw.relocateAbroad === "boolean"
      );
      if (typeof raw.bornMuslim === "boolean") clean.bornMuslim = raw.bornMuslim;
      if (typeof raw.haveChildren === "boolean") clean.haveChildren = raw.haveChildren;
      if (typeof raw.relocateAbroad === "boolean") clean.relocateAbroad = raw.relocateAbroad;
      if (!hasValue) {
        // If nothing was provided, don't update the whole embedded document
        // to `{}`. Just skip the update.
        break;
      }
      profileUpdates.aboutYou = clean;
      break;

    case 19:
      profileUpdates.personalityTraits = Array.isArray(payload.personalityTraits)
        ? payload.personalityTraits
        : [];
      break;

    case 20:
      profileUpdates.interests = {
        cultural: Array.isArray(payload.cultural) ? payload.cultural : [],
        foodDrinks: Array.isArray(payload.foodDrinks) ? payload.foodDrinks : [],
        sports: Array.isArray(payload.sports) ? payload.sports : [],
        fashion: Array.isArray(payload.fashion) ? payload.fashion : [],
        activities: Array.isArray(payload.activities) ? payload.activities : [],
      };
      break;

    //bio
    case 21: {
      const explicitAboutMe =
        typeof payload.aboutMe === "string" ? payload.aboutMe.trim() : payload.aboutMe;

      // Check if user requested AI generation or provided no manual aboutMe with AI flag
      if (
        payload.generateAi ||
        payload.useAi ||
        payload.isAiGenerated ||
        (!explicitAboutMe && payload.generateAi !== false && payload.aboutMe === undefined)
      ) {
        aiBioResult = await generateAiBioForUser(userId, {
          tone: payload.tone,
          keywords: payload.keywords,
        });
        profileUpdates.aboutMe = explicitAboutMe || aiBioResult.bio;
      } else {
        profileUpdates.aboutMe = explicitAboutMe;
      }
      break;
    }

    case 22: {
      const uploadedFiles =
        Array.isArray(req.files) && req.files.length > 0
          ? req.files
          : req.file
            ? [req.file]
            : [];

      if (uploadedFiles.length > 0) {
        const filePaths = uploadedFiles.map((file) => `/public/upload/${file.filename}`);
        profileUpdates.images = filePaths;
      } else if (payload.images) {
        profileUpdates.images = Array.isArray(payload.images)
          ? payload.images
          : [payload.images];
      }
      break;
    }
    //befor step all ok--
    case 23: {
      // Step 23: Send phone OTP
      const phone = requireString(payload.phone, "Phone");
      const code = await issueOtp(phone, "phone_verification");
      const devCode = await deliverOtp(phone, code, "phone_verification");
      user.phone = phone;
      await user.save({ validateBeforeSave: false });
      return res.status(200).json(
        new ApiResponse(200, { devCode, phone }, "SMS verification code sent")
      );
    }

    case 24: {
      // Step 24: Verify phone code
      const code = requireString(payload.code, "Verification code");
      if (!user.phone) throw new ApiError(400, "Phone number has not been set");
      await verifyOtp(user.phone, "phone_verification", code);
      user.isPhoneVerified = true;
      user.onboardingStep = Math.max(user.onboardingStep || 1, nextStep);
      await user.save({ validateBeforeSave: false });
      break;
    }

    case 26: {
      // Step 26: Location selection
      profileUpdates.city = payload.city;
      profileUpdates.country = payload.country || "Bangladesh";
      profileUpdates.locationRadius = payload.locationRadius || "large";
      if (payload.longitude !== undefined && payload.latitude !== undefined) {
        const lng = Number(payload.longitude);
        const lat = Number(payload.latitude);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          profileUpdates.location = { type: "Point", coordinates: [lng, lat] };
        }
      }
      break;
    }

    case 27: {
      // Step 27: Partner preference
      await PartnerPreference.findOneAndUpdate(
        { userId },
        {
          $set: {
            ageRange: payload.ageRange || { min: MIN_AGE, max: MAX_AGE },
            heightRange: payload.heightRange,
            preferredReligions: payload.preferredReligions,
            preferredSects: payload.preferredSects,
            maritalStatuses: payload.maritalStatuses,
            preferredCities: payload.preferredCities,
            verifiedOnly: Boolean(payload.verifiedOnly),
          },
        },
        { upsert: true, new: true }
      );
      break;
    }

    default:
      break;
  }

  // Update Profile document for steps 5-27
  if (stepNumber !== 4) {
    profile = await Profile.findOneAndUpdate(
      { userId },
      { $set: profileUpdates },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  // Sync user step progression
  if (user && (user.onboardingStep || 1) < nextStep) {
    user.onboardingStep = nextStep;
    await user.save({ validateBeforeSave: false });
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        step: nextStep,
        profile,
        ...(aiBioResult ? { aiBio: aiBioResult } : {}),
      },
      `Step ${stepNumber} saved successfully`
    )
  );
});

/**
 * POST /api/v1/onboarding/complete
 * Finalize onboarding, compute completeness score, and prepare profile for moderation
 */
export const completeOnboarding = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [user, profile, preference, photos] = await Promise.all([
    User.findById(userId),
    Profile.findOne({ userId }),
    PartnerPreference.findOne({ userId }),
    ProfilePhoto.find({ userId, isApproved: true }),
  ]);

  if (!user || !profile) {
    throw new ApiError(400, "Incomplete profile. Please complete the required steps.");
  }

  const score = computeCompleteness({
    profile,
    photoCount: photos.length,
    preference: Boolean(preference),
  });

  profile.completeness = score;
  profile.isOnboardingCompleted = true;
  profile.profileStatus = PROFILE_STATUS.PENDING;
  await profile.save();

  user.isOnboardingComplete = true;
  user.onboardingStep = 27;
  await user.save({ validateBeforeSave: false });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: {
          _id: user._id,
          fullName: user.fullName,
          isOnboardingComplete: user.isOnboardingComplete,
        },
        profile,
        completeness: score,
      },
      "Onboarding completed successfully! Your profile is now being reviewed."
    )
  );
});
