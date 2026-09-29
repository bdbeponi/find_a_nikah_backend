import multer from "multer";

// The single place API errors get shaped. Everything reaches here: asyncHandler
// forwards rejections with next(err), and plain middlewares (role guards, CORS,
// multer, the JSON body parser) call next(err) directly. Without this, Express
// answers those with its default HTML error page.
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Something went wrong";
  let errors = Array.isArray(err.errors) ? err.errors : [];

  if (err.name === "ValidationError" && err.errors) {
    statusCode = 400;
    errors = Object.values(err.errors).map((e) => e.message);
    message = errors[0] || message;
  }

  if (err.code === 11000) {
    statusCode = 409;
    message = `Duplicate value for: ${Object.keys(err.keyValue || {}).join(", ")}`;
  }

  if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }

  if (err instanceof multer.MulterError) {
    statusCode = 400;
    message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Image must be 5MB or smaller"
        : err.message;
  }

  // Thrown by the multer fileFilter for a disallowed file type
  if (err.message?.startsWith("Only jpeg")) {
    statusCode = 400;
  }

  if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "Request body is not valid JSON";
  }

  if (statusCode >= 500) {
    // The full error goes to the log, never to the client. An unhandled 500
    // message is an internal detail - "phone.trim is not a function" tells an
    // attacker the shape of the code and tells a user nothing.
    console.error("❌", err);
    if (process.env.NODE_ENV === "production") {
      message = "Something went wrong";
      errors = [];
    }
  }

  res.status(statusCode).json({
    statusCode,
    success: false,
    message,
    errors,
  });
};

export { errorHandler };
