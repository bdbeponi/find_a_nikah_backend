import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { requireString } from "../utils/requireString.js";
import { User } from "../models/user.model.js";
import {
  cookieOptions,
  issueTokens,
  revokeAllForUser,
  revokeToken,
  rotateTokens,
} from "../services/auth.service.js";
import { ACCOUNT_STATUS, GENDERS, ROLES } from "../constants.js";
import { deliverOtp, issueOtp, verifyOtp } from "../services/otp.service.js";

// Enough to tie a session to a device without storing anything identifying.
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

/** POST /api/v1/auth/register - members only. Staff are made in the admin panel. */
const register = asyncHandler(async (req, res) => {
  const { fullName, phone: rawPhone, email, password, gender } = req.body;

  const phone = requireString(rawPhone, "Phone");

  if (!GENDERS.includes(gender)) {
    throw new ApiError(400, `Gender must be one of: ${GENDERS.join(", ")}`);
  }

  if (typeof password !== "string" || password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }

  if (await User.findOne({ phone })) {
    throw new ApiError(409, "An account with this phone already exists");
  }

  const user = await User.create({
    fullName: requireString(fullName, "Full name"),
    phone,
    email: email?.trim().toLowerCase() || undefined,
    password,
    gender,
    // Never from the body. `role` and `accountStatus` arriving in a signup
    // payload is how an open registration endpoint mints an admin.
    role: ROLES.MEMBER,
  });

  const tokens = await issueTokens(user, clientInfo(req));

  return withTokens(res, 201, tokens, { user }, "Registration successful");
});

/** POST /api/v1/auth/login */
const login = asyncHandler(async (req, res) => {
  const { phone, email, password } = req.body;

  if ((!email) || typeof password !== "string" || !password) {
    throw new ApiError(400, "Phone (or email) and password are required");
  }

  const user = await User.findOne(
    email
      ? { email: requireString(email, "Email").toLowerCase() }
      : { phone: requireString(phone, "Phone") }
  ).select("+password");

  // One message for both halves on purpose: saying which was wrong turns the
  // login form into a "does this number have an account" oracle.
  if (!user || !(await user.isPasswordCorrect(password))) {
    throw new ApiError(401, "Invalid credentials");
  }

  if (user.accountStatus === ACCOUNT_STATUS.DELETED) {
    throw new ApiError(401, "Invalid credentials");
  }
  if (user.accountStatus === ACCOUNT_STATUS.SUSPENDED) {
    throw new ApiError(403, "Account is suspended");
  }

  user.lastActiveAt = new Date();
  await user.save({ validateBeforeSave: false });

  const tokens = await issueTokens(user, clientInfo(req));

  return withTokens(res, 200, tokens, { user }, "Login successful");
});

/** POST /api/v1/auth/refresh - spends the presented token and returns a new pair. */
const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!presented) throw new ApiError(401, "Refresh token is required");

  const { accessToken, refreshToken } = await rotateTokens(
    presented,
    clientInfo(req)
  );

  return withTokens(res, 200, { accessToken, refreshToken }, {}, "Token refreshed");
});

/** POST /api/v1/auth/logout - this device only. */
const logout = asyncHandler(async (req, res) => {
  await revokeToken(req.cookies?.refreshToken || req.body?.refreshToken);

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions())
    .clearCookie("refreshToken", cookieOptions())
    .json(new ApiResponse(200, null, "Logged out successfully"));
});

/** POST /api/v1/auth/logout-all - every device. */
const logoutAll = asyncHandler(async (req, res) => {
  await revokeAllForUser(req.user._id);

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions())
    .clearCookie("refreshToken", cookieOptions())
    .json(new ApiResponse(200, null, "Signed out of every device"));
});

/**
 * POST /api/v1/auth/otp/send - a code for confirming a phone number.
 *
 * Signup does not block on this; the code confirms a number that already has
 * an account, so the identifier is taken from the session, never from the body.
 * Letting the caller name the phone would turn this into a way to spam any
 * number on the network.
 */
const sendOtp = asyncHandler(async (req, res) => {
  if (req.user.isPhoneVerified) {
    throw new ApiError(409, "This number is already confirmed");
  }

  const code = await issueOtp(req.user.phone, "phone_verification");
  const devCode = await deliverOtp(req.user.phone, code, "phone_verification");

  return res
    .status(200)
    .json(new ApiResponse(200, { devCode }, "Code sent"));
});

/** POST /api/v1/auth/otp/verify - spends the code and marks the phone. */
const confirmPhone = asyncHandler(async (req, res) => {
  await verifyOtp(req.user.phone, "phone_verification", req.body?.code);

  await User.updateOne(
    { _id: req.user._id },
    { $set: { isPhoneVerified: true } }
  );

  return res.status(200).json(new ApiResponse(200, null, "Phone confirmed"));
});

/**
 * POST /api/v1/auth/forgot-password
 *
 * Answers 200 whether or not the number has an account. The reply is the only
 * thing an attacker sees, and a 404 here is a free list of which phone numbers
 * are registered - on a matrimony site that is worth money to somebody.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const phone = requireString(req.body?.phone, "Phone");
  const user = await User.findOne({ phone });

  let devCode = null;
  if (user && user.accountStatus === ACCOUNT_STATUS.ACTIVE) {
    const code = await issueOtp(phone, "password_reset");
    devCode = await deliverOtp(phone, code, "password_reset");
  }

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { devCode },
        "If that number has an account, a code is on its way"
      )
    );
});

/**
 * POST /api/v1/auth/reset-password
 *
 * The code is spent before the account is looked up, so a valid code cannot be
 * replayed against a second guess at the phone number. Every session dies with
 * the old password - whoever forced the reset should not keep a live one.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const phone = requireString(req.body?.phone, "Phone");
  const { code, newPassword } = req.body || {};

  if (typeof newPassword !== "string" || newPassword.length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters");
  }

  await verifyOtp(phone, "password_reset", code);

  const user = await User.findOne({ phone }).select("+password");
  if (!user || user.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
    throw new ApiError(400, "That code is invalid or has expired");
  }

  user.password = newPassword;
  await user.save();

  await revokeAllForUser(user._id);

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Password reset, please log in"));
});

export {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  sendOtp,
  confirmPhone,
  forgotPassword,
  resetPassword,
};
