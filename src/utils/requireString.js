import { ApiError } from "./apiError.js";

/**
 * A required text field, coerced and trimmed.
 *
 * The coercion is the point. `req.body.phone` is whatever JSON arrived, so a
 * bare `phone.trim()` throws a TypeError on `{"phone": 123456}` or
 * `{"phone": []}` — a 500 on input a client fully controls. This turns the same
 * request into the 400 it always should have been.
 */
export const requireString = (value, label) => {
  if (value === null || value === undefined) {
    throw new ApiError(400, `${label} is required`);
  }
  // An object would stringify to "[object Object]", which is not a phone number
  if (typeof value === "object") {
    throw new ApiError(400, `${label} must be text`);
  }
  const text = String(value).trim();
  if (!text) throw new ApiError(400, `${label} is required`);
  return text;
};
