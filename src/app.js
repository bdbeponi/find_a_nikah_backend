import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

// Registers every schema with mongoose up front
import "./models/index.js";

import mongoose from "mongoose";

import authRouter from "./routes/auth.routes.js";
import onboardingRouter from "./routes/onboarding.routes.js";
import userRouter from "./routes/user.routes.js";
import adminRouter from "./routes/admin.routes.js";
import profileRouter from "./routes/profile.routes.js";
import discoveryRouter from "./routes/discovery.routes.js";
import {
  likeRouter,
  passRouter,
  matchRouter,
  blockRouter,
  reportRouter,
} from "./routes/interaction.routes.js";
import { conversationRouter, messageRouter } from "./routes/chat.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import {
  planRouter,
  paymentRouter,
  subscriptionRouter,
} from "./routes/billing.routes.js";
import { errorHandler } from "./middlewares/error.middlewares.js";
import { securityHeaders } from "./middlewares/security.middlewares.js";
import {
  ensureBody,
  sanitizeRequest,
} from "./middlewares/sanitize.middlewares.js";
import { clearCacheOnWrite } from "./utils/cache.js";
import { ApiError } from "./utils/apiError.js";

// __dirname setup for ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Nothing gains from telling the world which framework this is
app.disable("x-powered-by");
app.use(securityHeaders);

// CORS - explicit origin list, credentials on so HTTP-only cookies work.
// Read per request, never at module scope: this file is imported before
// index.js runs, so anything captured up here would see an empty process.env
// and quietly fall back to the default.
const allowedOrigins = () =>
  (process.env.CORS_ORIGIN || "http://localhost:3002")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins().includes(origin)) {
        return callback(null, true);
      }
      callback(new ApiError(403, `Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(cookieParser());
// The raw bytes are kept alongside the parsed body purely for the payment
// webhook: its HMAC is over exactly what the gateway sent, and re-stringifying
// the parsed object reorders keys, so every real callback would fail the check.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Both after the body parsers and before any route. ensureBody gives every
// controller an object to destructure; sanitizeRequest refuses anything
// carrying a Mongo operator as a field name. See sanitize.middlewares.js.
app.use(ensureBody);
app.use(sanitizeRequest);

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, slow down" },
  })
);

// Uploaded images are served from disk, never stored in MongoDB
app.use(
  "/public/upload",
  express.static(path.join(__dirname, "../public/upload"), { maxAge: "7d" })
);

app.get("/", (req, res) => {
  res.send("🚀 Find A Nikah backend is running successfully!");
});

/**
 * Health, for the load balancer.
 *
 * Reports the database too: a process that is listening but cannot reach Mongo
 * answers every real request with a 500, and a health check that only proves
 * "node is running" would keep routing traffic to it. readyState 1 is
 * connected; anything else is degraded, and the 503 takes it out of rotation.
 */
app.get("/health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    success: connected,
    status: connected ? "healthy" : "degraded",
    database: connected ? "connected" : "disconnected",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Routes
// Every successful write empties the response cache, so no controller has to
// remember to.
app.use("/api/v1", clearCacheOnWrite);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/onboarding", onboardingRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/admin", adminRouter);

// The member-facing half - the mobile app talks to these.
app.use("/api/v1/profile", profileRouter);
app.use("/api/v1/profiles", discoveryRouter);
app.use("/api/v1/notifications", notificationRouter);
// One mount per prefix. A router mounted at "/api/v1" would run its own
// router.use(verifyJWT) against every /api/v1 request, including the ones meant
// for a router mounted after it - which is how the public pricing endpoint
// started answering 401.
app.use("/api/v1/likes", likeRouter);
app.use("/api/v1/passes", passRouter);
app.use("/api/v1/matches", matchRouter);
app.use("/api/v1/blocks", blockRouter);
app.use("/api/v1/reports", reportRouter);
app.use("/api/v1/conversations", conversationRouter);
app.use("/api/v1/messages", messageRouter);
app.use("/api/v1/plans", planRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/subscriptions", subscriptionRouter);

// 404 for unmatched API routes
app.use("/api", (req, res) => {
  res
    .status(404)
    .json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// Must stay last - Express only treats a 4-arg middleware as an error handler
app.use(errorHandler);

export { app };
