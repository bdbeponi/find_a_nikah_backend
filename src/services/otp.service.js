import crypto from "node:crypto";
import { OtpVerification } from "../models/otpVerification.model.js";
import { ApiError } from "../utils/apiError.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES } from "../constants.js";

// Same hash as the refresh tokens: deterministic, so the code can be looked up
// rather than compared against every open row. bcrypt salts, which would make
// the lookup a full scan.
const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code)).digest("hex");

/**
 * crypto.randomInt, not Math.random.
 *
 * Math.random is seeded from the clock and its sequence is predictable from a
 * couple of outputs - which for a password-reset code means guessable. The
 * padStart keeps a leading zero, so "012345" stays six digits.
 */
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** Phone or email, normalised the same way every time it is looked up. */
export const normaliseIdentifier = (value) => String(value).trim().toLowerCase();

/**
 * Issues a code, invalidating any earlier one for the same identifier and
 * purpose.
 *
 * Invalidating first matters: two "resend" taps would otherwise leave two live
 * codes, and the older one stays guessable for its full five minutes after the
 * member has moved on to the newer.
 */
export const issueOtp = async (rawIdentifier, purpose) => {
  const identifier = normaliseIdentifier(rawIdentifier);

  await OtpVerification.updateMany(
    { identifier, purpose, consumedAt: { $exists: false } },
    { $set: { consumedAt: new Date() } }
  );

  const code = newCode();

  await OtpVerification.create({
    identifier,
    purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
  });

  return code;
};

/**
 * Spends a code. Throws on anything that is not an exact, live, unused match.
 *
 * A wrong guess costs an attempt whether or not the identifier has a code at
 * all, and the message never distinguishes "no such code" from "wrong code" -
 * the difference is what tells an attacker which numbers have a reset running.
 */
export const verifyOtp = async (rawIdentifier, purpose, rawCode) => {
  const identifier = normaliseIdentifier(rawIdentifier);
  const code = String(rawCode ?? "").trim();

  const record = await OtpVerification.findOne({
    identifier,
    purpose,
    consumedAt: { $exists: false },
  })
    .sort({ createdAt: -1 })
    .select("+codeHash");

  if (!record || !record.isUsable()) {
    throw new ApiError(400, "That code is invalid or has expired");
  }

  if (record.codeHash !== hashCode(code)) {
    record.attempts += 1;
    // Burning it at the cap is the point of the cap: without this the row
    // stays open and only the counter moves.
    if (record.attempts >= OTP_MAX_ATTEMPTS) record.consumedAt = new Date();
    await record.save({ validateBeforeSave: false });
    throw new ApiError(400, "That code is invalid or has expired");
  }

  record.consumedAt = new Date();
  await record.save({ validateBeforeSave: false });

  return true;
};

/**
 * Hands the code to whoever has to receive it.
 *
 * ponytail: no SMS gateway is wired up, so the code goes to the server log and
 * - outside production only - back in the response, which is what makes the
 * mobile app testable today. Replace the body with the provider call; the
 * production branch already refuses to leak it.
 */
export const deliverOtp = async (identifier, code, purpose) => {
  console.log(`📨 OTP for ${identifier} (${purpose}): ${code}`);
  return process.env.NODE_ENV === "production" ? null : code;
};
