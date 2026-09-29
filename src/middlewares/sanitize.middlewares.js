import { ApiError } from "../utils/apiError.js";

// MongoDB reads a key beginning with "$" as an operator, so a JSON body of
//   { "phone": { "$ne": null }, "password": "x" }
// stops being data and becomes a query. No legitimate request to this API ever
// carries one, so rather than quietly stripping it and letting a controller
// stumble over the leftover object, the whole request is refused.
//
// Dotted keys go the same way: { "profile.isVerified": true } reaches into a
// subdocument the caller was never handed. So do the prototype keys, which are
// how a JSON body turns into prototype pollution.
//
// Only the KEYS are checked. A value is free to contain anything - a bio is
// free text and may hold anything the member typed.

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isDangerous = (key) =>
  key.startsWith("$") || key.includes(".") || BLOCKED_KEYS.has(key);

// A deeply nested body is its own small denial of service, so the walk stops.
const MAX_DEPTH = 12;

const findDangerousKey = (value, depth = 0) => {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDangerousKey(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (isDangerous(key)) return key;
    const found = findDangerousKey(value[key], depth + 1);
    if (found) return found;
  }

  return null;
};

/**
 * Guarantees req.body is an object.
 *
 * Express 5 leaves it undefined when a request carries no body at all, or a
 * content type the parsers do not handle - so destructuring it in a controller
 * throws a TypeError, which is a 500 on input the caller fully controls. A
 * third of the controllers here had that shape, and it only showed up when a
 * script probed a route with no body at all.
 *
 * It lives beside sanitizeRequest because it is the same job: make the body
 * safe to read before any handler touches it.
 */
export const ensureBody = (req, _res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
};

/**
 * Runs after the body parsers and before every route.
 */
export const sanitizeRequest = (req, res, next) => {
  for (const target of [req.body, req.query, req.params]) {
    const found = findDangerousKey(target);
    if (found) {
      return next(new ApiError(400, `Disallowed field name: ${found}`));
    }
  }
  return next();
};

export { findDangerousKey };
