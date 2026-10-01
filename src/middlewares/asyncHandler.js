// Express 4 does not catch rejected promises from middleware; this forwards them to the error handler.
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === "function") r.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { asyncHandler };
