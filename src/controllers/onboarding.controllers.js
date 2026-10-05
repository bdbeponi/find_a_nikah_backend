import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { requireString } from "../utils/requireString.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { PartnerPreference } from "../models/partnerPreference.model.js";
import { ProfilePhoto } from "../models/profilePhoto.model.js";
import { ProfileVerification } from "../models/profileVerification.model.js";
import {
  cookieOptions,
  issueTokens,
} from "../services/auth.service.js";
import {
  deliverOtp,
  issueOtp,
  verifyOtp,
} from "../services/otp.service.js";
import {
  ACCOUNT_STATUS,
  ACCOUNT_TYPES,
  GENDERS,
  MAX_AGE,
  MIN_AGE,
  PROFILE_FOR,
  PROFILE_STATUS,
  RELIGIONS,
  ROLES,
} from "../constants.js";
import { checkDateOfBirth, computeCompleteness } from "./profile.controllers.js";

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
 * STEP 1: POST /api/v1/onboarding/email/send-code
 * Send email verification OTP
 */
export const sendEmailOtp = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const targetEmail = requireString(email, "Email").toLowerCase();

  // If email is already in use by an active completed user, reject early
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
    new ApiResponse(
      200,
      { devCode },
      "Verification code sent to your email"
    )
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

  // Check if account already exists
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
    // Resume onboarding for incomplete registration
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
    User.findById(userId).select("fullName email phone gender accountType profileFor onboardingStep isOnboardingComplete isPhoneVerified isEmailVerified"),
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

/**
 * PATCH /api/v1/onboarding/step
 * Generic step progress saver (Steps 4 to 27)
 */
export const saveOnboardingStep = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { step, data = {}, isSkip = false } = req.body;

  const stepNumber = Number(step);
  if (!Number.isInteger(stepNumber) || stepNumber < 4 || stepNumber > 27) {
    throw new ApiError(400, "Step must be an integer between 4 and 27");
  }

  let profile = await Profile.findOne({ userId });
  let user = await User.findById(userId);

  // If skipped, advance step if not already further
  if (isSkip) {
    const nextStep = Math.min(stepNumber + 1, 27);
    if (user && user.onboardingStep <= stepNumber) {
      user.onboardingStep = nextStep;
      await user.save({ validateBeforeSave: false });
    }
    if (profile && profile.onboardingStep <= stepNumber) {
      profile.onboardingStep = nextStep;
      await profile.save({ validateBeforeSave: false });
    }
    return res.status(200).json(
      new ApiResponse(200, { step: nextStep, skipped: true }, `Step ${stepNumber} skipped`)
    );
  }

  // Handle specific step logic
  switch (stepNumber) {
    case 4: {
      // Step 4: Individual or family account & core demographics
      const {
        accountType = "individual",
        profileFor = "self",
        fullName,
        birthDate,
        dateOfBirth,
        gender,
        religion = "islam",
        language,
        languages = [],
      } = data;

      if (!ACCOUNT_TYPES.includes(accountType)) {
        throw new ApiError(400, `accountType must be one of: ${ACCOUNT_TYPES.join(", ")}`);
      }
      if (!PROFILE_FOR.includes(profileFor)) {
        throw new ApiError(400, `profileFor must be one of: ${PROFILE_FOR.join(", ")}`);
      }
      if (!GENDERS.includes(gender)) {
        throw new ApiError(400, `gender must be one of: ${GENDERS.join(", ")}`);
      }

      const dob = dateOfBirth || birthDate;
      const dobError = checkDateOfBirth(dob);
      if (dobError) throw new ApiError(400, dobError);

      const name = requireString(fullName, "Full name");

      // Update User
      user.fullName = name;
      user.gender = gender;
      user.accountType = accountType;
      user.profileFor = profileFor;
      user.onboardingStep = Math.max(user.onboardingStep || 1, 5);
      await user.save({ validateBeforeSave: false });

      const langList = language ? [language] : Array.isArray(languages) ? languages : [];

      // Create or update Profile
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            accountType,
            profileFor,
            gender,
            dateOfBirth: new Date(dob),
            religion,
            motherTongue: langList[0] || "Bengali",
            languages: langList,
            onboardingStep: Math.max(profile?.onboardingStep || 1, 5),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      break;
    }

    case 5: {
      // Step 5: What brings you to Find A Nikah (intent)
      const { intent } = data;
      if (intent) {
        profile = await Profile.findOneAndUpdate(
          { userId },
          { $set: { intent, onboardingStep: Math.max(profile?.onboardingStep || 1, 6) } },
          { new: true, upsert: true }
        );
      }
      break;
    }

    case 6: {
      // Step 6: Referral source
      const { referralSource } = data;
      if (referralSource) {
        profile = await Profile.findOneAndUpdate(
          { userId },
          { $set: { referralSource, onboardingStep: Math.max(profile?.onboardingStep || 1, 7) } },
          { new: true, upsert: true }
        );
      }
      break;
    }

    case 7: {
      // Step 7: Nationality
      const { nationality } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { nationality: nationality || "Bangladeshi", onboardingStep: Math.max(profile?.onboardingStep || 1, 8) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 8: {
      // Step 8: Grow up (where you grew up)
      const { grewUpIn } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { grewUpIn, onboardingStep: Math.max(profile?.onboardingStep || 1, 9) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 9: {
      // Step 9: Ethnicity
      const { ethnicity } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { ethnicity, onboardingStep: Math.max(profile?.onboardingStep || 1, 10) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 10: {
      // Step 10: Height
      const { heightCm } = data;
      const height = Number(heightCm);
      if (Number.isFinite(height)) {
        profile = await Profile.findOneAndUpdate(
          { userId },
          { $set: { heightCm: height, onboardingStep: Math.max(profile?.onboardingStep || 1, 11) } },
          { new: true, upsert: true }
        );
      }
      break;
    }

    case 11: {
      // Step 11: Education Level
      const { educationLevel } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { educationLevel, onboardingStep: Math.max(profile?.onboardingStep || 1, 12) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 12: {
      // Step 12: Profession
      const { profession, professionTitle } = data;
      const title = professionTitle || profession;
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { professionTitle: title, onboardingStep: Math.max(profile?.onboardingStep || 1, 13) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 13: {
      // Step 13: Marital status
      const { maritalStatus } = data;
      if (maritalStatus) {
        profile = await Profile.findOneAndUpdate(
          { userId },
          { $set: { maritalStatus, onboardingStep: Math.max(profile?.onboardingStep || 1, 14) } },
          { new: true, upsert: true }
        );
      }
      break;
    }

    case 14: {
      // Step 14: Intentions for marriage
      const { getToknowDuration, marriageTimeline } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            "marriageIntentions.getToknowDuration": getToknowDuration,
            "marriageIntentions.marriageTimeline": marriageTimeline,
            onboardingStep: Math.max(profile?.onboardingStep || 1, 15),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 15: {
      // Step 15: Faith / Sect
      const { sect, religion } = data;
      const updates = { onboardingStep: Math.max(profile?.onboardingStep || 1, 16) };
      if (sect) updates.sect = sect;
      if (religion) updates.religion = religion;
      profile = await Profile.findOneAndUpdate({ userId }, { $set: updates }, { new: true, upsert: true });
      break;
    }

    case 16: {
      // Step 16: Religious practice
      const { religiousPractice, religiousness } = data;
      const updates = { onboardingStep: Math.max(profile?.onboardingStep || 1, 17) };
      if (religiousPractice) updates.religiousPractice = religiousPractice;
      if (religiousness) updates.religiousness = religiousness;
      profile = await Profile.findOneAndUpdate({ userId }, { $set: updates }, { new: true, upsert: true });
      break;
    }

    case 17: {
      // Step 17: Lifestyle preferences
      const { halalFood, smoking, alcohol } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            "lifestyle.halalFood": halalFood || "always",
            "lifestyle.smoking": smoking || "never",
            "lifestyle.alcohol": alcohol || "never",
            onboardingStep: Math.max(profile?.onboardingStep || 1, 18),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 18: {
      // Step 18: About you (born muslim, children, relocate)
      const { bornMuslim, haveChildren, relocateAbroad } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            "aboutYou.bornMuslim": bornMuslim || "born_muslim",
            "aboutYou.haveChildren": haveChildren || "no",
            "aboutYou.relocateAbroad": relocateAbroad || "maybe",
            onboardingStep: Math.max(profile?.onboardingStep || 1, 19),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 19: {
      // Step 19: Personality description
      const { personalityTraits } = data;
      const traits = Array.isArray(personalityTraits) ? personalityTraits : [];
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            personalityTraits: traits,
            onboardingStep: Math.max(profile?.onboardingStep || 1, 20),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 20: {
      // Step 20: Interests (cultural, food/drinks, sports, fashion, activities)
      const { cultural = [], foodDrinks = [], sports = [], fashion = [], activities = [] } = data;
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            "interests.cultural": Array.isArray(cultural) ? cultural : [],
            "interests.foodDrinks": Array.isArray(foodDrinks) ? foodDrinks : [],
            "interests.sports": Array.isArray(sports) ? sports : [],
            "interests.fashion": Array.isArray(fashion) ? fashion : [],
            "interests.activities": Array.isArray(activities) ? activities : [],
            onboardingStep: Math.max(profile?.onboardingStep || 1, 21),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 21: {
      // Step 21: Bio (aboutMe)
      const { bio, aboutMe } = data;
      const text = requireString(aboutMe || bio, "Bio");
      profile = await Profile.findOneAndUpdate(
        { userId },
        {
          $set: {
            aboutMe: text,
            onboardingStep: Math.max(profile?.onboardingStep || 1, 22),
          },
        },
        { new: true, upsert: true }
      );
      break;
    }

    case 22: {
      // Step 22: Profile photo step acknowledgment
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { onboardingStep: Math.max(profile?.onboardingStep || 1, 23) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 23: {
      // Step 23: Verify phone (send code)
      const { phone } = data;
      const targetPhone = requireString(phone, "Phone");
      const code = await issueOtp(targetPhone, "phone_verification");
      const devCode = await deliverOtp(targetPhone, code, "phone_verification");

      user.phone = targetPhone;
      await user.save({ validateBeforeSave: false });

      return res.status(200).json(
        new ApiResponse(200, { devCode, phone: targetPhone }, "SMS verification code sent")
      );
    }

    case 24: {
      // Step 24: Verify phone code
      const { code } = data;
      const targetCode = requireString(code, "Verification code");
      if (!user.phone) throw new ApiError(400, "Phone number has not been set");

      await verifyOtp(user.phone, "phone_verification", targetCode);
      user.isPhoneVerified = true;
      user.onboardingStep = Math.max(user.onboardingStep || 1, 25);
      await user.save({ validateBeforeSave: false });

      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { onboardingStep: Math.max(profile?.onboardingStep || 1, 25) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 25: {
      // Step 25: Verify image / ID step acknowledgment
      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { onboardingStep: Math.max(profile?.onboardingStep || 1, 26) } },
        { new: true, upsert: true }
      );
      break;
    }

    case 26: {
      // Step 26: Location selection (small or large radius)
      const { city, country = "Bangladesh", latitude, longitude, locationRadius = "large" } = data;
      const updates = {
        city,
        country,
        locationRadius,
        onboardingStep: Math.max(profile?.onboardingStep || 1, 27),
      };

      if (longitude !== undefined && latitude !== undefined) {
        const lng = Number(longitude);
        const lat = Number(latitude);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          updates.location = { type: "Point", coordinates: [lng, lat] };
        }
      }

      profile = await Profile.findOneAndUpdate({ userId }, { $set: updates }, { new: true, upsert: true });
      break;
    }

    case 27: {
      // Step 27: Add partner preference filters
      const {
        ageRange,
        heightRange,
        preferredReligions,
        preferredSects,
        maritalStatuses,
        preferredCities,
        verifiedOnly = false,
      } = data;

      await PartnerPreference.findOneAndUpdate(
        { userId },
        {
          $set: {
            ageRange: ageRange || { min: MIN_AGE, max: MAX_AGE },
            heightRange,
            preferredReligions,
            preferredSects,
            maritalStatuses,
            preferredCities,
            verifiedOnly,
          },
        },
        { upsert: true, new: true }
      );

      profile = await Profile.findOneAndUpdate(
        { userId },
        { $set: { onboardingStep: 27 } },
        { new: true, upsert: true }
      );
      break;
    }

    default:
      break;
  }

  // Sync user step
  const nextStep = Math.min(stepNumber + 1, 27);
  if (user && user.onboardingStep <= stepNumber) {
    user.onboardingStep = nextStep;
    await user.save({ validateBeforeSave: false });
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      { step: nextStep, profile },
      `Step ${stepNumber} saved successfully`
    )
  );
});

/**
 * POST /api/v1/onboarding/complete
 * Finalize onboarding, compute completeness score, and prepare profile
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
  profile.profileStatus = PROFILE_STATUS.PENDING; // Sent to moderation queue
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
