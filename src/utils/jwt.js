import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * Token plumbing, in one place.
 *
 * This used to be two methods on the user schema. It moved out because a
 * refresh token is now a row in its own collection - rotated on every use and
 * stored hashed - and a schema method cannot reach across models to do that.
 *
 * The access token stays stateless: it is checked by signature alone, never
 * looked up, which is the whole point of it being short-lived.
 */

/** Only what an authorisation decision needs. Never an email, never a name. */
export const signAccessToken = (user) =>
  jwt.sign(
    { _id: user._id, role: user.role },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
  );

export const verifyAccessToken = (token) =>
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

/**
 * The refresh token carries no claims worth reading - it is an opaque secret
 * whose only job is to be looked up. Signing it anyway means a garbage string
 * is rejected before it ever reaches the database.
 */
export const signRefreshToken = (user) =>
  jwt.sign(
    // A random jti makes every issued token distinct even when two are minted
    // for the same user in the same second, so the unique index on the hash
    // cannot collide.
    { _id: user._id, jti: crypto.randomUUID() },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
  );

export const verifyRefreshToken = (token) =>
  jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);

/**
 * What gets stored for a refresh token.
 *
 * SHA-256, not bcrypt: the lookup is by hash, so it has to be deterministic -
 * bcrypt salts, which would mean scanning every row and comparing one at a
 * time. The input here is 200+ bits of signed randomness rather than a human
 * password, so there is nothing to brute force and no salt to need.
 */
export const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

/** When a freshly signed refresh token stops being valid. */
export const refreshTokenExpiry = () => {
  const { exp } = jwt.decode(
    jwt.sign({}, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
    })
  );
  return new Date(exp * 1000);
};
