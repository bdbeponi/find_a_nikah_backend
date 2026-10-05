# Find A Nikah — Backend Architecture & Complete Guide

A production-grade, highly secure Muslim Matrimony backend built with **Node.js, Express 5, MongoDB (Mongoose 8), Socket.IO, and Redis**.

---

## 📑 Table of Contents
1. [System Architecture Overview](#system-architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Environment Configuration](#environment-configuration)
4. [Domain Models & Database Schemas](#domain-models--database-schemas)
5. [Authentication & Session Lifecycle](#authentication--session-lifecycle)
6. [Security & Protection Mechanisms](#security--protection-mechanisms)
7. [API Route Reference](#api-route-reference)
8. [Real-time WebSockets & Chat](#real-time-websockets--chat)
9. [Subscriptions, Entitlements & Billing](#subscriptions-entitlements--billing)
10. [Background Scripts & Database Operations](#background-scripts--database-operations)
11. [Running Locally](#running-locally)

---

## 1. System Architecture Overview

The application follows a **Layered Clean Architecture (Routes → Middlewares → Controllers → Services → Models → DB/Socket/Redis)**:

- **Routes (`src/routes/`)**: Mount endpoints, assign path-specific rate-limiters, and map routes to controller actions.
- **Middlewares (`src/middlewares/`)**: Handle JWT verification, RBAC authorization, carrier-grade NAT rate-limiting, Mongo query sanitization, and Multer file parsing.
- **Controllers (`src/controllers/`)**: Parse HTTP inputs, orchestrate domain operations via services, and return standardized `ApiResponse` objects.
- **Services (`src/services/`)**: Encapsulate complex business logic (matching algorithms, OTP management, payment verification, search filters, entitlement checks, audit logging).
- **Models (`src/models/`)**: Mongoose schemas featuring custom pre/post hooks, compound & partial indexes, TTL automatic cleanup, and custom serialization transforms (`toPublicJSON`).
- **Real-time Layer (`src/socket/`)**: Socket.IO integration on the unified HTTP server handling 1-on-1 chat, typing indicators, and push events.
- **Caching Layer (`src/utils/cache.js`)**: Opt-in Redis caching for public read queries with automatic cache invalidation on any write (`clearCacheOnWrite`).

---

## 2. Directory Structure

```plaintext
find_a_nikah_backend/
├── .env.example              # Environment variables template
├── package.json              # ES Modules dependencies & scripts
├── public/
│   └── upload/               # Stored images (avatars, attachments, verifications)
└── src/
    ├── app.js                # Express app setup, CORS, global middlewares & router mounts
    ├── constants.js          # System-wide enums, constants, status codes & ranges
    ├── index.js              # Server entry point, DB boot, socket attachment, graceful shutdown
    ├── config/
    │   ├── env.js            # Environment validation & assertions
    │   └── loadEnv.js        # Early .env loader
    ├── db/
    │   └── index.js          # MongoDB connection handler
    ├── models/               # 19 Mongoose Schemas
    │   ├── index.js          # Central schema registration export
    │   ├── user.model.js
    │   ├── profile.model.js
    │   ├── education.model.js
    │   ├── profession.model.js
    │   ├── family.model.js
    │   ├── partnerPreference.model.js
    │   ├── profilePhoto.model.js
    │   ├── profileVerification.model.js
    │   ├── profileView.model.js
    │   ├── like.model.js
    │   ├── match.model.js
    │   ├── block.model.js
    │   ├── report.model.js
    │   ├── conversation.model.js
    │   ├── message.model.js
    │   ├── notification.model.js
    │   ├── subscriptionPlan.model.js
    │   ├── subscription.model.js
    │   ├── payment.model.js
    │   ├── otpVerification.model.js
    │   ├── refreshToken.model.js
    │   └── auditLog.model.js
    ├── controllers/          # HTTP request handlers
    │   ├── admin.controllers.js
    │   ├── adminContent.controllers.js
    │   ├── adminModeration.controllers.js
    │   ├── auth.controllers.js
    │   ├── billing.controllers.js
    │   ├── chat.controllers.js
    │   ├── discovery.controllers.js
    │   ├── interaction.controllers.js
    │   ├── notification.controllers.js
    │   ├── profile.controllers.js
    │   └── user.controllers.js
    ├── middlewares/          # Request filters & interceptors
    │   ├── auth.middlewares.js
    │   ├── error.middlewares.js
    │   ├── multer.middlewares.js
    │   ├── sanitize.middlewares.js
    │   └── security.middlewares.js
    ├── routes/               # API endpoint definitions
    │   ├── admin.routes.js
    │   ├── auth.routes.js
    │   ├── billing.routes.js
    │   ├── chat.routes.js
    │   ├── discovery.routes.js
    │   ├── interaction.routes.js
    │   ├── notification.routes.js
    │   ├── profile.routes.js
    │   └── user.routes.js
    ├── services/             # Core business & domain logic
    │   ├── audit.service.js
    │   ├── auth.service.js
    │   ├── block.service.js
    │   ├── entitlement.service.js
    │   ├── match.service.js
    │   ├── notification.service.js
    │   ├── otp.service.js
    │   ├── payment.service.js
    │   └── search.service.js
    ├── socket/               # Real-time WebSocket handlers & emitter
    │   ├── emit.js
    │   └── index.js
    ├── scripts/              # Operational & CLI tools
    │   ├── check-auth.js
    │   ├── expire-subscriptions.js
    │   ├── seed.js
    │   ├── seed-plans.js
    │   └── sync-indexes.js
    └── utils/                # Cross-cutting utilities
        ├── apiError.js
        ├── apiResponse.js
        ├── asyncHandler.js
        ├── cache.js
        ├── image.js
        ├── jwt.js
        ├── pagination.js
        ├── requireString.js
        ├── search.js
        └── slugify.js
```

---

## 3. Environment Configuration

The application validates every variable at boot using `assertEnv()` in `src/config/env.js`. If any required secret is missing or contains placeholder values (e.g. `changeme`), the server refuses to start to prevent forged tokens.

Key configuration variables:
- `PORT`: HTTP server port (Default: `8007`)
- `MONGODB_URL`: Full MongoDB URI with authentication credentials and database name
- `ACCESS_TOKEN_SECRET` & `ACCESS_TOKEN_EXPIRY`: HMAC secret and lifespan for short-lived access JWTs (Default: `1d`)
- `REFRESH_TOKEN_SECRET` & `REFRESH_TOKEN_EXPIRY`: Secret and lifespan for long-lived rotated refresh JWTs (Default: `10d`)
- `CORS_ORIGIN`: Comma-separated list of allowed browser origins
- `REDIS_URL`: (Optional) Redis connection URI for query caching
- `PAYMENT_WEBHOOK_SECRET`: HMAC-SHA256 secret for verifying payment gateway callbacks

---

## 4. Domain Models & Database Schemas

### 1. User (`src/models/user.model.js`)
- **Purpose**: Identity and account authentication (email, phone, bcrypt password hash).
- **Key Fields**: `fullName`, `phone`, `email`, `gender`, `role` (`super_admin`, `admin`, `moderator`, `member`), `accountStatus` (`active`, `suspended`, `deleted`), `isVerified`, `passwordChangedAt`, `lastActiveAt`.
- **Security Features**:
  - `password` is marked `select: false` and explicitly deleted in JSON transform.
  - Automatic `bcrypt` hashing on both `.save()` and `.findOneAndUpdate()`.
  - `passwordChangedAt` timestamp invalidates previously minted access tokens.

### 2. Profile (`src/models/profile.model.js`)
- **Purpose**: Searchable matrimonial attributes.
- **Key Fields**: `userId`, `gender`, `dateOfBirth` (DOB stored instead of age for indexed queries), `heightCm` (stored in cm, not feet/inches), `maritalStatus`, `religion`, `sect`, `religiousness`, `city`, `location` (GeoJSON Point with 2dsphere index), `aboutMe`, `profileStatus` (`pending`, `published`, `rejected`, `hidden`), `isDiscoverable`, `completeness`.
- **Virtuals**: `age` calculated on-the-fly from `dateOfBirth`.

### 3. Education (`src/models/education.model.js`)
- **Purpose**: Multi-entry academic qualifications (`degree`, `institution`, `fieldOfStudy`, `yearOfPassing`, `grade`).

### 4. Profession (`src/models/profession.model.js`)
- **Purpose**: Work history and income disclosure.
- **Privacy Rule**: `incomeVisibility` (`public`, `matches_only`, `private`). Managed via `toPublicJSON(viewerIsMatch)` to ensure unauthorized users cannot view financial figures.

### 5. Family (`src/models/family.model.js`)
- **Purpose**: Parents' status and sibling counts.
- **Validation**: Enforces `marriedBrothers <= brothers` and `marriedSisters <= sisters`.

### 6. PartnerPreference (`src/models/partnerPreference.model.js`)
- **Purpose**: Criteria for matching and recommendations (ranges for age/height, preferred religions, sects, marital statuses, cities, income).

### 7. ProfilePhoto (`src/models/profilePhoto.model.js`)
- **Purpose**: Photo gallery with moderation controls.
- **Rules**: Must be approved by a moderator (`isApproved`) before appearing publicly. Primary photo constraint ensures only one primary photo exists per user.

### 8. ProfileVerification (`src/models/profileVerification.model.js`)
- **Purpose**: Identity proof submissions (`nid`, `passport`, `birth_certificate`, `driving_licence`).
- **Access Control**: Scans are kept private; only the owner and staff can view them.

### 9. Like (`src/models/like.model.js`)
- **Purpose**: Direct user interactions (`pending`, `matched`, `withdrawn`). Unique index on `(fromUserId, toUserId)` prevents duplicate likes.

### 10. Match (`src/models/match.model.js`)
- **Purpose**: Confirmed mutual likes.
- **Deduplication**: `orderPair(userA, userB)` ensures sorted ObjectId storage so duplicate reciprocal likes map to the identical match record.

### 11. Block (`src/models/block.model.js`) & Report (`src/models/report.model.js`)
- **Block**: Directional record; searches exclude blocked and blocking users bidirectionally.
- **Report**: Moderation complaints with partial indexes preventing spam reports for unresolved issues.

### 12. Conversation (`src/models/conversation.model.js`) & Message (`src/models/message.model.js`)
- **Conversation**: 1-on-1 thread per match, storing denormalized `lastMessageAt`, `lastMessagePreview`, and per-user `unread` count maps.
- **Message**: Cursor-paginated chat messages (`text`, `image`, `system`). Supports per-user deletion without removing chat history for the other participant.

### 13. Notification (`src/models/notification.model.js`)
- **Purpose**: Real-time push & in-app alerts with a 90-day automatic MongoDB TTL expiration index.

### 14. Billing (`SubscriptionPlan`, `Subscription`, `Payment`)
- **SubscriptionPlan**: Tier specifications with minor integer pricing (`priceMinor` in poisha/cents).
- **Subscription**: Active plan instance with immutable `featuresSnapshot` to honor purchase-time terms.
- **Payment**: Payment gateway transaction log with idempotent `gatewayRef` deduplication against replayed webhooks.

### 15. Security & Accountability (`OtpVerification`, `RefreshToken`, `AuditLog`)
- **OtpVerification**: Hashed one-time codes with attempt throttling and automatic TTL expiration.
- **RefreshToken**: Rotated SHA-256 token records with replay detection.
- **AuditLog**: Immutable, append-only administrative action ledger.

---

## 5. Authentication & Session Lifecycle

```
Member Request (Phone & Password)
       │
       ▼
[rateLimit (IP & per-phone)]
       │
       ▼
POST /api/v1/auth/login
       │
       ├──> Validate password using bcrypt
       ├──> Generate short-lived Access Token (JWT)
       ├──> Generate cryptographically secure Refresh Token
       ├──> Hash Refresh Token (SHA-256) & store in RefreshToken collection
       └──> Set HTTP-Only, Secure, SameSite Cookies & return tokens in payload
```

### Refresh Token Rotation with Automatic Reuse Detection
1. When `/api/v1/auth/refresh` is called, the provided refresh token is hashed and checked against the database.
2. If the token was **already revoked** (found in `replacedBy` chain), the system assumes token theft and **revokes all active sessions** for that user immediately (`detectReuse`).
3. If valid, the old token is marked revoked and replaced by a newly minted refresh token.

---

## 6. Security & Protection Mechanisms

1. **Carrier-Grade NAT Resilient Rate Limiting**:
   - In Bangladesh, mobile internet providers place thousands of devices behind shared CG-NAT IP addresses. A rigid IP-only limiter would inadvertently lock out whole regions.
   - The backend isolates IP limiting (`100 req/15min`) from credential limiting (`10 attempts/15min keyed on phone number`).
2. **MongoDB Operator Injection Defense**:
   - The `sanitizeRequest` middleware recurses through request bodies and query parameters, rejecting keys beginning with `$` or containing `.`.
3. **Image Scrubbing via Sharp**:
   - Every uploaded image is re-encoded into `.webp` format, which scrubs all EXIF, GPS location, and camera metadata before being written to disk.
4. **Payment Webhook Verification**:
   - The raw byte buffer (`req.rawBody`) is preserved during JSON body parsing to calculate HMAC-SHA256 signatures accurately without key reordering bugs.

---

## 7. API Route Reference

### Authentication (`/api/v1/auth`)
- `POST /register`: Create member account
- `POST /login`: Log in with phone/password
- `POST /refresh`: Rotate refresh token & obtain new access token
- `POST /logout`: Invalidate current refresh token
- `POST /logout-all`: Invalidate all active sessions for current user (JWT required)
- `POST /otp/send`: Request SMS OTP verification code
- `POST /otp/verify`: Verify phone number with received OTP
- `POST /forgot-password`: Request password reset OTP
- `POST /reset-password`: Reset password using verified OTP

### Onboarding Flow (`/api/v1/onboarding`)
- `POST /email/send-code`: Send email verification code (Step 1)
- `POST /email/verify-code`: Verify email OTP code (Step 2)
- `POST /account`: Register account with password & confirm password (Step 3)
- `GET /status`: Fetch current onboarding progress, step number, and saved data
- `PATCH /step`: Save step data (Steps 4 to 27) or skip optional steps (`{ step: Number, data: Object, isSkip: Boolean }`)
- `POST /complete`: Finalize onboarding and submit profile for moderation review

### Discovery & Search (`/api/v1/profiles`)
- `GET /search`: Filter profiles with cursor pagination (age, height, religion, city, education)
- `GET /recommendations`: Ranked suggestions matching authenticated user's partner preferences
- `GET /feed/liked-similar`: **Liked Similar** feed (profiles matching traits of users you liked)
- `GET /feed/second-look`: **Second Look** feed (passed profiles, prioritizing candidates who liked you)
- `GET /feed/live`: **Currently Available / Live** feed (users active in the last 30 minutes)
- `GET /feed/visited-you`: **Visited You** feed (members who viewed your profile)
- `GET /feed/just-joined`: **Just Joined** feed (new profiles published in the last 14 days)
- `GET /feed/near-you`: **Active Near You** feed (nearby profiles via GeoJSON coordinates)
- `GET /:id`: View public profile (records view event & applies visibility rules)
- `GET /me/viewers`: List of members who viewed authenticated user's profile
- `GET /me/viewed`: List of profiles viewed by authenticated user

### Interactions & Passes (`/api/v1`)
- `POST /likes/:userId`: Send like (triggers match if mutual)
- `DELETE /likes/:userId`: Withdraw like
- `GET /likes/received`: List incoming likes (gated by subscription)
- `GET /likes/sent`: List sent likes
- `POST /passes/:userId`: Pass on a profile (swipe left)
- `DELETE /passes/:userId`: Undo pass on a profile
- `GET /passes`: Retrieve list of passed profiles
- `GET /matches`: Retrieve active matches
- `POST /matches/:matchId/unmatch`: Terminate an active match
- `POST /blocks/:userId`: Block user (hides each other bidirectionally)
- `DELETE /blocks/:userId`: Unblock user
- `POST /reports/:userId`: Report user for misconduct

### Chat & Messaging (`/api/v1`)
- `GET /conversations`: List active chat threads with unread counts
- `GET /messages/:conversationId`: Fetch messages using cursor pagination
- `POST /messages/:conversationId`: Send text or image message
- `DELETE /messages/:messageId`: Soft delete message for current user

### Billing & Plans (`/api/v1`)
- `GET /plans`: List active subscription packages (public / cached)
- `POST /payments/initiate`: Create payment request for a plan
- `POST /payments/webhook`: Webhook handler for payment gateway (HMAC protected)
- `GET /subscriptions/my`: Get current subscription status & active entitlements

### Administration & Moderation (`/api/v1/admin`)
- `GET /stats`: System metrics (user count, active subscriptions, revenue)
- `GET /users`: Search and filter member accounts
- `PATCH /users/:id/status`: Suspend or reinstate user
- `GET /moderation/photos`: Queue of pending profile photos
- `PATCH /moderation/photos/:id`: Approve or reject photo
- `GET /moderation/verifications`: Queue of pending identity verifications
- `PATCH /moderation/verifications/:id`: Approve or reject verification document
- `GET /moderation/reports`: Open member reports
- `PATCH /moderation/reports/:id`: Resolve or dismiss report
- `GET /audit-logs`: Immutable audit trail of staff actions

---

## 8. Real-time WebSockets & Chat

WebSockets are handled by Socket.IO (`src/socket/index.js`) mounted on the same HTTP server port.

### Connection & Authentication
Clients connect with their JWT access token:
```javascript
const socket = io("http://localhost:8007", {
  auth: { token: accessToken },
});
```
Each user joins an isolated private room named after their `userId`.

### Socket Events
| Event | Direction | Payload | Description |
|---|---|---|---|
| `typing` | Client → Server | `{ conversationId, to }` | Emit typing indicator |
| `typing` | Server → Client | `{ conversationId, from }` | Forwarded typing event |
| `message:new` | Server → Client | `{ message, conversationId }` | Incoming chat message |
| `match:new` | Server → Client | `{ matchId, conversationId }` | Real-time notification of mutual match |
| `notification` | Server → Client | Notification object | Real-time alert push |

---

## 9. Subscriptions, Entitlements & Billing

Unpaid vs. Paid features are controlled via `src/services/entitlement.service.js`:

```javascript
export const FREE_FEATURES = {
  maxLikesPerDay: 10,
  canMessageBeforeMatch: false,
  canSeeWhoLikedMe: false,
  canSeeContactDetails: false,
  boostedInSearch: false,
};
```

When a user purchases a plan, the plan's feature flags are copied into `Subscription.featuresSnapshot` at that exact moment. Any future updates by administrators to the plan catalog will **not** alter existing active subscriber entitlements.

---

## 10. Background Scripts & Database Operations

All scripts run directly with Node:
- **`npm run check:auth`**: Comprehensive test suite validating password hashing, token expiration, stale token detection, and age range conversions.
- **`npm run sync-indexes`**: Synchronizes all compound, partial, and 2dsphere indexes defined in Mongoose schemas with MongoDB.
- **`npm run seed:plans`**: Populates default membership plans (Silver, Gold, Platinum).
- **`npm run seed`**: Seeds mock accounts, profiles, preferences, and an initial admin account.
- **`npm run expire-subscriptions`**: Background cron job to transition expired subscriptions to `expired` status.

---

## 11. Running Locally

### Prerequisites
- Node.js (v18+)
- MongoDB (v4.4+)
- Redis (Optional, for caching)

### Steps
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env` file:
   ```bash
   cp .env.example .env
   ```
   Generate secure random keys for `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Initialize database indexes:
   ```bash
   npm run sync-indexes
   ```
4. Seed default subscription plans and admin:
   ```bash
   npm run seed:plans
   npm run seed
   ```
5. Start development server:
   ```bash
   npm run dev
   ```
6. The backend server will be live at `http://localhost:8007`. Health check can be verified at `http://localhost:8007/health`.
