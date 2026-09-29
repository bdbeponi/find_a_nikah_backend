// The response headers that actually matter for a JSON API plus a folder of
// uploaded images. Deliberately not helmet: this is six setHeader calls, and a
// dependency that ships twelve middlewares to use one is more to audit, not less.
export const securityHeaders = (req, res, next) => {
  // Never let a browser guess that an uploaded .jpg is really a script
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // The site runs on a different origin and has to be able to load images
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  // Only meaningful over HTTPS, and setting it in dev would pin localhost to
  // https in the browser for six months.
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains"
    );
  }

  next();
};
