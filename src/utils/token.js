const crypto = require("crypto");
const config = require("../config/env");

if (config.NODE_ENV === "production" && (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32)) {
  throw new Error("SESSION_SECRET (32+ characters) is required when NODE_ENV=production");
}

const SECRET = config.SESSION_SECRET || "advocateflow-local-secret";

function signToken(sessionId) {
  const body = Buffer.from(sessionId).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}

function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (expect.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

module.exports = { SECRET, signToken, readToken };
