import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  sendOtp,
  confirmPhone,
  forgotPassword,
  resetPassword,
} from "../controllers/auth.controllers.js";

const router = Router();

/**
 * Two limiters, because they guard two different things.
 *
 * One tight per-IP limit across every credential endpoint does not work here.
 * Bangladeshi mobile networks put thousands of subscribers behind one
 * carrier-grade NAT address, so a shared budget of twenty attempts locks out a
 * whole neighbourhood the moment a handful of people mistype a password - and
 * an attacker working through a list of numbers just rotates their address.
 *
 * So the phone number carries the tight limit, because the number is what is
 * being guessed at, and the IP carries a loose one to stop a single host
 * hammering the endpoint at all.
 */
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again later" },
});

// ipKeyGenerator, not req.ip, on every fallback: a raw IPv6 address is one out
// of the /64 its owner was handed, so keying on it lets the same person come
// back with a fresh address for free. The library refuses to start without it,
// which is how this was found.
const perPhone = (req) =>
  String(
    req.body?.phone || req.body?.email || req.user?.phone || ipKeyGenerator(req.ip)
  );

/** Ten guesses at one account per quarter of an hour. */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: perPhone,
  message: { success: false, message: "Too many attempts, try again later" },
});

/**
 * Tighter still for anything that sends a code. Every request here costs an
 * SMS, so this one is about the bill as much as the security - without it, one
 * script turns the gateway account into somebody else's budget.
 */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: perPhone,
  message: { success: false, message: "Too many code requests, try again later" },
});

router.route("/register").post(ipLimiter, register);
router.route("/login").post(ipLimiter, credentialLimiter, login);

// Not rate limited the same way: a legitimate client refreshes on a timer, and
// locking that out signs people out mid-session.
router.route("/refresh").post(refresh);

router.route("/logout").post(logout);
router.route("/logout-all").post(verifyJWT, logoutAll);

// Confirming your own number - the phone comes from the session, not the body
router.route("/otp/send").post(verifyJWT, otpLimiter, sendOtp);
router.route("/otp/verify").post(verifyJWT, credentialLimiter, confirmPhone);

router.route("/forgot-password").post(ipLimiter, otpLimiter, forgotPassword);
router.route("/reset-password").post(ipLimiter, credentialLimiter, resetPassword);

export default router;
