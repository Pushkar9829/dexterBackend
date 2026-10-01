const { AUTH_RATE_PER_MIN } = require("../config/env");

// Fixed one-minute window per client IP and route, held in memory: counts reset when the API restarts, and each
// API process counts on its own.
const hits = new Map();

function rateLimit(name, perMinute = AUTH_RATE_PER_MIN) {
  return (req, res, next) => {
    const now = Date.now();
    const key = name + "|" + (req.ip || "");
    let row = hits.get(key);
    if (!row || now - row.start >= 60000) {
      row = { start: now, count: 0 };
      hits.set(key, row);
    }
    row.count += 1;
    if (row.count > perMinute) {
      res.setHeader("Retry-After", String(Math.ceil((row.start + 60000 - now) / 1000)));
      return res.status(429).json({ error: "too many requests; wait a minute and try again" });
    }
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, row] of hits) if (row.start < cutoff) hits.delete(key);
}, 60000).unref();

module.exports = { rateLimit };
