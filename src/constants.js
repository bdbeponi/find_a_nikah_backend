export const DB_NAME = "find_a_nikah";

// Upload path that gets stored in DB and served statically by app.js
export const UPLOAD_DIR = "public/upload";

// Roles. Permission checks happen in middlewares/auth.middlewares.js -> authorizeRoles()
export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  MODERATOR: "moderator",
  MEMBER: "member",
};

export const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MODERATOR];

// Every match, search filter and photo visibility rule keys off this, so it
// lives here rather than inline in the user schema.
export const GENDERS = ["male", "female"];

/**
 * Account lifecycle. Replaces the old is_active boolean.
 *
 * A boolean could not tell "banned by a moderator" from "the member closed
 * their own account", and the two need different handling: a suspended account
 * can be restored, a deleted one is hidden from everything and only kept
 * because matches, payments and audit logs point at it.
 */
export const ACCOUNT_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
};

export const ACCOUNT_STATUSES = Object.values(ACCOUNT_STATUS);

/**
 * Profile moderation state.
 *
 * "published" is the only one that reaches search. A profile starts pending so
 * nobody becomes discoverable before a moderator has looked at them.
 */
export const PROFILE_STATUS = {
  PENDING: "pending",
  PUBLISHED: "published",
  REJECTED: "rejected",
  HIDDEN: "hidden",
};

export const PROFILE_STATUSES = Object.values(PROFILE_STATUS);

export const MARITAL_STATUSES = [
  "never_married",
  "divorced",
  "widowed",
  "separated",
];

export const RELIGIONS = [
  "islam",
  "hinduism",
  "christianity",
  "buddhism",
  "other",
];

// Free-typed sects would make the preference filter useless, so the list is closed.
export const SECTS = ["sunni", "shia", "other", "prefer_not_to_say"];

export const RELIGIOUSNESS = [
  "practising",
  "moderately_practising",
  "not_practising",
];

export const FAMILY_TYPES = ["joint", "nuclear"];

export const FAMILY_STATUSES = [
  "lower_class",
  "middle_class",
  "upper_middle_class",
  "affluent",
];

// Anything a member may choose to keep off their public profile.
export const VISIBILITY = {
  PUBLIC: "public",
  MATCHES_ONLY: "matches_only",
  PRIVATE: "private",
};

export const VISIBILITIES = Object.values(VISIBILITY);

export const LIKE_STATUSES = ["pending", "matched", "withdrawn"];
export const MATCH_STATUSES = ["active", "unmatched"];

export const REPORT_REASONS = [
  "fake_profile",
  "harassment",
  "inappropriate_photo",
  "spam",
  "underage",
  "already_married",
  "other",
];

export const REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"];

export const MESSAGE_TYPES = ["text", "image", "system"];

export const NOTIFICATION_TYPES = [
  "like_received",
  "match_created",
  "message_received",
  "profile_approved",
  "profile_rejected",
  "verification_approved",
  "verification_rejected",
  "subscription_expiring",
  "system",
];

export const VERIFICATION_STATUSES = ["pending", "approved", "rejected"];

export const VERIFICATION_DOC_TYPES = [
  "nid",
  "passport",
  "birth_certificate",
  "driving_licence",
];

export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "expired",
  "cancelled",
];

export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "refunded"];

// A code issued to confirm an identity must never be accepted for another purpose
export const OTP_PURPOSES = ["phone_verification", "email_verification", "password_reset"];

// How long a one-time code is good for, and how many guesses it allows.
export const OTP_TTL_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;

// Height is stored in centimetres, always. Feet-and-inches is a display
// concern; storing "5'6\"" makes a range query impossible.
export const HEIGHT_CM_MIN = 120;
export const HEIGHT_CM_MAX = 230;

// Nobody under this may hold a profile on a marriage site.
export const MIN_AGE = 18;
export const MAX_AGE = 80;

// ------------------------------------------------------------- onboarding
export const ACCOUNT_TYPES = ["individual", "family"];
export const PROFILE_FOR = [
  "self",
  "son",
  "daughter",
  "brother",
  "sister",
  "other_family_member",
  "client",
  "other",
];

export const ONBOARDING_INTENTS = [
  "know_first",
  "ready_soon",
  "curious",
  "other",
];

export const REFERRAL_SOURCES = [
  "social_media",
  "friend_or_family",
  "influencer",
  "ai_recommendation",
  "success_couple",
  "google_play_store",
  "apple_app_store",
  "advertisement",
  "other",
];

export const KNOW_DURATIONS = [
  "1-2_months",
  "3-4_months",
  "4-12_months",
  "flexible",
];

export const MARRIAGE_TIMELINES = [
  "1-2_months",
  "3-4_months",
  "1-2_years",
  "flexible",
];

export const RELIGIOUS_PRACTICES = [
  "strictly_practising",
  "actively_practising",
  "moderately_practising",
  "not_practising",
];

export const HALAL_FOOD_HABITS = [
  "always",
  "mostly",
  "sometimes",
  "not_halal",
];

export const SMOKING_HABITS = [
  "never",
  "occasionally",
  "regularly",
];

export const ALCOHOL_HABITS = [
  "never",
  "occasionally",
  "regularly",
];

export const BORN_MUSLIM_STATUS = [
  "born_muslim",
  "revert",
];

export const CHILDREN_STATUS = [
  "no",
  "yes_living_together",
  "yes_living_apart",
];

export const RELOCATE_STATUS = [
  "yes",
  "no",
  "maybe",
];

export const LOCATION_RADIUS_OPTIONS = ["small", "large"];
