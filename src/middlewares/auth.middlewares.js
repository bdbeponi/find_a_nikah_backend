import { User } from "../models/user.model.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { ACCOUNT_STATUS, ADMIN_ROLES } from "../constants.js";

const readToken = (req) =>
  req.cookies?.accessToken ||
  req.header("Authorization")?.replace("Bearer ", "");

/**
 * Whether this token predates the account's last password change.
 *
 * Its own function, and exported, because of the unit mismatch: a JWT's `iat`
 * is in seconds and a Date is in milliseconds, so comparing them directly is
 * wrong by a factor of a thousand and wrong in the safe-looking direction -
 * every token passes and nothing ever appears broken.
 */
export const isTokenStale = (iatSeconds, passwordChangedAt) => {
  if (!passwordChangedAt) return false;
  return iatSeconds * 1000 < new Date(passwordChangedAt).getTime();
};

/**
 * Turns a valid access token into req.user.
 *
 * The database is still hit on every request even though the token is
 * self-contained: a suspended or deleted account has to stop working
 * immediately, and a token signed a minute ago would otherwise keep letting
 * them in until it expired.
 */
export const verifyJWT = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);

  if (!token) {
    throw new ApiError(401, "Unauthorized request");
  }

  let decodedToken;
  try {
    decodedToken = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, "Invalid or expired access token");
  }

  const user = await User.findById(decodedToken._id);

  if (!user) {
    throw new ApiError(401, "User not found");
  }

  // Deliberately the same message a missing account gets: confirming that a
  // deleted account once existed is more than a caller needs to know.
  if (user.accountStatus === ACCOUNT_STATUS.DELETED) {
    throw new ApiError(401, "User not found");
  }

  if (user.accountStatus === ACCOUNT_STATUS.SUSPENDED) {
    throw new ApiError(403, "Account is suspended");
  }

  if (isTokenStale(decodedToken.iat, user.passwordChangedAt)) {
    throw new ApiError(401, "Password changed, please log in again");
  }

  req.user = user;
  next();
});

// Guest browsing: attach req.user when a valid token exists, never reject.
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next();

  try {
    const decodedToken = verifyAccessToken(token);
    const user = await User.findById(decodedToken._id);
    req.user = user?.accountStatus === ACCOUNT_STATUS.ACTIVE ? user : undefined;
  } catch {
    req.user = undefined;
  }
  next();
});

// Role gate enforced at the API layer, never only by hiding UI.
export const authorizeRoles =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, "Unauthorized request"));
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new ApiError(403, "You do not have permission to perform this action")
      );
    }
    next();
  };

export const isAdmin = authorizeRoles(...ADMIN_ROLES);
