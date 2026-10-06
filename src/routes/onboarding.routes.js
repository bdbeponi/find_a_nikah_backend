import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  completeOnboarding,
  getOnboardingStatus,
  registerAccount,
  saveOnboardingStep,
  sendEmailOtp,
  verifyEmailOtp,
} from "../controllers/onboarding.controllers.js";

const onboardingRouter = Router();

const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, try again later" },
});

const perEmail = (req) =>
  String(req.body?.email || req.user?.email || ipKeyGenerator(req.ip));

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: perEmail,
  message: { success: false, message: "Too many code requests, try again later" },
});

// Step 1: Send email OTP
onboardingRouter.route("/email/send-code").post(ipLimiter, otpLimiter, sendEmailOtp);

// Step 2: Verify email OTP
onboardingRouter.route("/email/verify-code").post(ipLimiter, verifyEmailOtp);

// Step 3: Register account
onboardingRouter.route("/account").post(ipLimiter, registerAccount);

// Protected onboarding routes (Steps 4 to 27)
onboardingRouter.use(verifyJWT);

onboardingRouter.route("/status").get(getOnboardingStatus);
onboardingRouter.route("/step").patch(saveOnboardingStep);
onboardingRouter.route("/complete").post(completeOnboarding);

export default onboardingRouter;
