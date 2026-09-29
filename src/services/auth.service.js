import { RefreshToken } from "../models/refreshToken.model.js";
import { ApiError } from "../utils/apiError.js";
import {
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../utils/jwt.js";

/**
 * Sessions: issuing, rotating and revoking refresh tokens.
 *
 * Lives here rather than in the controller because three endpoints need it
 * (login, register, refresh) and because the reuse detection below is the kind
 * of rule that must not have three slightly different copies.
 */

/** A fresh pair, and a row recording the refresh half. */
export const issueTokens = async (user, { userAgent, ip } = {}) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshTokenExpiry(),
    userAgent,
    ip,
  });

  return { accessToken, refreshToken };
};

/**
 * Spends one refresh token and returns a new pair.
 *
 * Rotation means a refresh token is single use. That is what makes theft
 * detectable: the thief and the real member cannot both use the same token, so
 * whoever is second presents one that is already revoked.
 *
 * When that happens the whole family is killed rather than just the reused
 * token. We cannot tell which of the two is the thief, so the only safe move
 * is to end every session and make both sign in again.
 */
export const rotateTokens = async (presented, { userAgent, ip } = {}) => {
  let decoded;
  try {
    decoded = verifyRefreshToken(presented);
  } catch {
    throw new ApiError(401, "Invalid or expired refresh token");
  }

  const tokenHash = hashToken(presented);
  const stored = await RefreshToken.findOne({ tokenHash });

  if (!stored) {
    // Correctly signed but unknown to us: it was already rotated away and the
    // row has since expired out, or it was minted with a leaked secret.
    await revokeAllForUser(decoded._id);
    throw new ApiError(401, "Refresh token is no longer valid");
  }

  if (!stored.isUsable()) {
    /**
     * Two very different things land here, and treating them alike is a bug
     * that only shows up minutes after the fact.
     *
     * `replacedBy` is set only when a token was *spent* - rotated away for a
     * new one. A spent token turning up again means two parties are holding it
     * and one of them is a thief. We cannot tell which, so the whole family
     * dies and both have to sign in again.
     *
     * A token with no `replacedBy` was revoked deliberately: the member pressed
     * "sign out this device", or support signed them out. That device carries
     * on refreshing on its own timer for a while, and calling that theft would
     * sign the member out of every *other* device minutes after they ended one
     * on purpose - the exact opposite of what they asked for.
     */
    if (stored.replacedBy) {
      await revokeAllForUser(stored.userId);
      throw new ApiError(
        401,
        "This session was ended for security reasons, please log in again"
      );
    }

    throw new ApiError(401, "This device was signed out, please log in again");
  }

  const user = await stored.populate("userId").then((doc) => doc.userId);
  if (!user) throw new ApiError(401, "User not found");

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const nextHash = hashToken(refreshToken);

  await RefreshToken.create({
    userId: user._id,
    tokenHash: nextHash,
    expiresAt: refreshTokenExpiry(),
    userAgent,
    ip,
  });

  // Marked spent only after the replacement exists, so a crash in between
  // leaves the member with a token that still works rather than locked out.
  stored.revokedAt = new Date();
  stored.replacedBy = nextHash;
  await stored.save();

  return { accessToken, refreshToken, user };
};

/** Sign out of this one device. */
export const revokeToken = async (presented) => {
  if (!presented) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(presented), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

/** Sign out everywhere: a password change, a suspension, a detected theft. */
export const revokeAllForUser = async (userId) => {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
};

/**
 * Cookie settings for both tokens.
 *
 * sameSite none in production because the API and the site are on different
 * hosts, and a browser will not send a cross-site cookie otherwise. That
 * combination requires secure, which is why env.js refuses to start on a
 * plain-http CORS origin in production.
 */
export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
});
