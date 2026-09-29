// Checked once, at boot, before the server listens.
//
// A backend that starts happily on ACCESS_TOKEN_SECRET="CHANGE_ME..." signs
// tokens anybody can forge, and nothing about it looks wrong from the outside.
// The only safe failure here is a loud one.

const PLACEHOLDER = /^(change[_-]?me|changeme|secret|your[_-]?secret|xxx+|todo)/i;

// A JWT secret shorter than this is brute-forceable offline.
const MIN_SECRET_LENGTH = 32;

const required = [
  "MONGODB_URL",
  "ACCESS_TOKEN_SECRET",
  "ACCESS_TOKEN_EXPIRY",
  "REFRESH_TOKEN_SECRET",
  "REFRESH_TOKEN_EXPIRY",
];

const secrets = ["ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET"];

/**
 * Returns every problem rather than the first, so one restart tells you
 * everything that is wrong instead of six.
 *
 * Pure: it reads the object handed to it, which is what makes it testable.
 */
export const checkEnv = (env = process.env) => {
  const problems = [];
  const warnings = [];
  const isProduction = env.NODE_ENV === "production";

  for (const key of required) {
    if (!env[key]?.trim()) problems.push(`${key} is not set`);
  }

  for (const key of secrets) {
    const value = env[key]?.trim();
    if (!value) continue;

    if (PLACEHOLDER.test(value)) {
      problems.push(`${key} is still a placeholder — generate a real one`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(
        `${key} is ${value.length} characters; use at least ${MIN_SECRET_LENGTH}`
      );
    }
  }

  // Two secrets that match mean a refresh token is accepted as an access token,
  // which quietly turns a long-lived credential into a permanent session.
  if (
    env.ACCESS_TOKEN_SECRET &&
    env.ACCESS_TOKEN_SECRET === env.REFRESH_TOKEN_SECRET
  ) {
    problems.push(
      "ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET are identical — a refresh token would pass as an access token"
    );
  }

  const origins = (env.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (!origins.length) {
    (isProduction ? problems : warnings).push(
      "CORS_ORIGIN is not set — the site will be blocked by the browser"
    );
  }

  if (isProduction) {
    const local = origins.filter((o) => /localhost|127\.0\.0\.1/.test(o));
    if (local.length) {
      problems.push(`CORS_ORIGIN still allows ${local.join(", ")} in production`);
    }

    const insecure = origins.filter((o) => o.startsWith("http://"));
    if (insecure.length) {
      // Cookies are set with secure+sameSite=none in production, and a browser
      // refuses those over plain http - login would fail silently.
      problems.push(
        `CORS_ORIGIN must be https in production: ${insecure.join(", ")}`
      );
    }

    if (env.MONGODB_URL?.includes("localhost")) {
      warnings.push("MONGODB_URL points at localhost");
    }
  } else {
    warnings.push(`NODE_ENV is "${env.NODE_ENV || "unset"}", not "production"`);
  }

  return { problems, warnings, isProduction };
};

/** Called from index.js before the server listens. Throws rather than warns. */
export const assertEnv = (env = process.env) => {
  const { problems, warnings } = checkEnv(env);

  for (const warning of warnings) {
    console.warn(`⚠️  ${warning}`);
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start — fix these in .env:\n` +
        problems.map((p) => `   • ${p}`).join("\n")
    );
  }
};
