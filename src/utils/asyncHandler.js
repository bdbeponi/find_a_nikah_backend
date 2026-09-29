// Forwards rejections to the error middleware so every failure - thrown,
// rejected or next(err) - is formatted in one place.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export { asyncHandler };
