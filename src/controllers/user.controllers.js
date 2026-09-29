import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { User } from "../models/user.model.js";
import { Profile } from "../models/profile.model.js";
import { RefreshToken } from "../models/refreshToken.model.js";
import { cookieOptions, revokeAllForUser } from "../services/auth.service.js";
import { hashToken } from "../utils/jwt.js";
import { ACCOUNT_STATUS, PROFILE_STATUS } from "../constants.js";

/** GET /api/v1/users/me */
const getMe = asyncHandler(async (req, res) =>
  res.status(200).json(new ApiResponse(200, req.user, "Current user"))
);

/**
 * PATCH /api/v1/users/me - the account, not the profile.
 *
 * The allowed fields are listed rather than spread from the body. `req.body`
 * straight into an update is how `{"role":"admin"}` or
 * `{"accountStatus":"active"}` on a suspended account gets through.
 */
const updateMe = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const update = {};

  if (email !== undefined) {
    const next = String(email).trim().toLowerCase();
    if (next && (await User.findOne({ email: next, _id: { $ne: req.user._id } }))) {
      throw new ApiError(409, "That email is already in use");
    }
    update.email = next || undefined;
    // A new address has not been confirmed yet
    update.isEmailVerified = false;
  }

  if (!Object.keys(update).length) {
    throw new ApiError(400, "Nothing to update");
  }

  const user = await User.findByIdAndUpdate(req.user._id, update, {
    new: true,
    runValidators: true,
  });

  return res.status(200).json(new ApiResponse(200, user, "Account updated"));
});

/**
 * DELETE /api/v1/users/me - soft delete.
 *
 * Nothing is removed. Matches, conversations and payment history point at this
 * row, and a hard delete would leave the other side of a conversation talking
 * to a missing user. The profile is hidden in the same breath so they stop
 * appearing in search immediately, and every session is revoked.
 */
const deleteMe = asyncHandler(async (req, res) => {
  const { password } = req.body;

  // Re-authenticate: an unlocked phone left on a table should not be enough to
  // close somebody's account.
  const user = await User.findById(req.user._id).select("+password");
  if (typeof password !== "string" || !(await user.isPasswordCorrect(password))) {
    throw new ApiError(401, "Password is incorrect");
  }

  user.accountStatus = ACCOUNT_STATUS.DELETED;
  user.deletedAt = new Date();
  await user.save({ validateBeforeSave: false });

  await Profile.updateOne(
    { userId: user._id },
    { $set: { profileStatus: PROFILE_STATUS.HIDDEN, isDiscoverable: false } }
  );

  await revokeAllForUser(user._id);

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions())
    .clearCookie("refreshToken", cookieOptions())
    .json(new ApiResponse(200, null, "Account closed"));
});

/** PATCH /api/v1/users/me/password */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (typeof newPassword !== "string" || newPassword.length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters");
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user || !(await user.isPasswordCorrect(String(currentPassword || "")))) {
    throw new ApiError(401, "Current password is incorrect");
  }

  user.password = newPassword;
  await user.save();

  // Every other session dies with the old password - changing it is what
  // somebody does when they think a device is not theirs any more.
  await revokeAllForUser(user._id);

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions())
    .clearCookie("refreshToken", cookieOptions())
    .json(new ApiResponse(200, null, "Password changed, please log in again"));
});

/**
 * The device list a session row is meant to produce.
 *
 * Pure and exported so the check script can pin two things that are silently
 * wrong if they break: the current device must be marked (a list where none is
 * "this device" invites somebody to revoke the session they are sitting in and
 * wonder why they were signed out), and the token hash must never leave the
 * server - it is the credential itself, and a device list is exactly the screen
 * somebody screenshots for support.
 */
export const toSession = (row, currentHash) => ({
  _id: row._id,
  userAgent: row.userAgent || null,
  ip: row.ip || null,
  signedInAt: row.createdAt,
  expiresAt: row.expiresAt,
  isCurrent: Boolean(currentHash) && row.tokenHash === currentHash,
});

const presentedToken = (req) =>
  req.cookies?.refreshToken || req.body?.refreshToken;

/**
 * GET /api/v1/users/me/sessions - where this account is signed in.
 *
 * Only the live ones. A revoked or expired row is a session that already ended,
 * and listing it gives a member something alarming to look at that they cannot
 * act on.
 */
const getSessions = asyncHandler(async (req, res) => {
  const token = presentedToken(req);
  const currentHash = token ? hashToken(token) : null;

  const rows = await RefreshToken.find({
    userId: req.user._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        rows.map((row) => toSession(row, currentHash)),
        "Signed-in devices"
      )
    );
});

/**
 * DELETE /api/v1/users/me/sessions/:id - sign one device out.
 *
 * userId is in the filter, not checked after: a findById plus an ownership
 * check is one forgotten line away from letting anybody end anybody's session.
 */
const revokeSession = asyncHandler(async (req, res) => {
  const row = await RefreshToken.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!row) throw new ApiError(404, "Session not found");

  if (row.revokedAt) {
    return res.status(200).json(new ApiResponse(200, null, "Already signed out"));
  }

  row.revokedAt = new Date();
  await row.save();

  // Revoking the session you are currently using is a logout, and the cookies
  // have to go with it or the browser keeps sending a token that now fails.
  const token = presentedToken(req);
  const isCurrent = token && hashToken(token) === row.tokenHash;

  const response = res.status(200);
  if (isCurrent) {
    response
      .clearCookie("accessToken", cookieOptions())
      .clearCookie("refreshToken", cookieOptions());
  }

  return response.json(
    new ApiResponse(200, null, isCurrent ? "Signed out" : "That device was signed out")
  );
});

export {
  getMe,
  updateMe,
  deleteMe,
  changePassword,
  getSessions,
  revokeSession,
};
