const fs = require("fs");
const path = require("path");
const express = require("express");
const config = require("./config/env");
const { asyncHandler } = require("./middlewares/asyncHandler");
const { loadSession } = require("./middlewares/auth");
const { apiNotFound, errorHandler } = require("./middlewares/errors");
const { readOnlyGuard } = require("./middlewares/rbac");

// Mount order matches the original registration order; paths inside each router are absolute (/api/...).
const ROUTERS = [
  "system",
  "auth",
  "companies",
  "projects",
  "users",
  "teams",
  "applications",
  "atms",
  "lookups",
  "employees",
  "franchises",
  "sites",
  "documents",
  "affidavits",
  "lois",
  "agreements",
  "registers",
  "apna",
  "site-projects",
  "ops",
  "imports",
  "complaints",
  "finance",
  "reports",
  "notices",
  "tasks",
  "dashboards",
  "home",
  "report-lists",
  "audit",
  "mail",
  "adapters",
  "hrms",
];

const WEB_DIST = path.join(__dirname, "..", "..", "frontend", "dist");
const WEB_INDEX = path.join(WEB_DIST, "index.html");

function createApp() {
  const app = express();
  app.set("trust proxy", config.TRUST_PROXY || false);
  // Versioned alias: /api/v1/... is served by the same handlers as /api/...
  app.use((req, res, next) => {
    if (req.url === "/api/v1" || req.url.startsWith("/api/v1/") || req.url.startsWith("/api/v1?")) req.url = "/api" + req.url.slice(7);
    next();
  });
  app.use(express.json({ limit: "20mb", verify: (req, res, buf) => (/^\/api\/(mail\/inbound-hook|hrms\/webhook)/.test(req.url) ? (req.rawBody = buf) : null) }));

  const allowed = new Set(String(config.CORS_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));
  const devOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.has(origin) || (config.NODE_ENV !== "production" && devOrigin.test(origin)))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Offline-At");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
    res.setHeader("Content-Security-Policy", CSP);
    if (config.NODE_ENV === "production" && req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  if (fs.existsSync(WEB_INDEX)) {
    app.use(
      express.static(WEB_DIST, {
        index: false,
        setHeaders(res, file) {
          const name = path.basename(file);
          if (name === "sw.js" || name === "index.html" || name.endsWith(".webmanifest")) res.setHeader("Cache-Control", "no-cache");
          else if (file.includes(path.sep + "assets" + path.sep)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (name.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
        },
      })
    );
  }

  app.use(asyncHandler(loadSession));
  app.use(readOnlyGuard);

  for (const name of ROUTERS) app.use(require("./modules/" + name + "/" + name + ".routes"));

  app.use("/api", apiNotFound);
  app.get("*", (req, res, next) => {
    if (!fs.existsSync(WEB_INDEX) || !req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(WEB_INDEX);
  });
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, ROUTERS };
