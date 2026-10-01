// Thrown by services for an expected failure; the handler answers with its status and message instead of a 500.
class AppError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

function apiNotFound(req, res) {
  res.status(404).json({ error: "not found" });
}

function errorHandler(err, req, res, _next) {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "request too large" });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  console.error(req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "server error" });
}

module.exports = { AppError, apiNotFound, errorHandler };
