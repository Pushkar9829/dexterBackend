const { ObjectId } = require("mongodb");
const { SESSION_IDLE_MINUTES } = require("../config/env");
const { endSessionLog } = require("../modules/audit/audit.service");
const { companyScope } = require("./rbac");
const { writeAudit } = require("../utils/audit-writer");
const repo = require("../utils/shared.repository");
const { readToken } = require("../utils/token");

// Resolves the bearer token to a live session and sets req.user / req.sessionId. Never rejects: routes decide with
// requireAuth whether a user is needed.
async function loadSession(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  req.user = null;
  if (!token) return next();
  const sessionId = readToken(token);
  if (!sessionId) return next();
  try {
    const session = await repo.sessions.findById(new ObjectId(sessionId));
    if (!session) return next();
    const now = new Date();
    const idle = session.lastSeenAt && now - new Date(session.lastSeenAt) > SESSION_IDLE_MINUTES * 60 * 1000;
    if ((session.expiresAt && session.expiresAt < now) || idle) {
      await repo.sessions.deleteById(session._id);
      await endSessionLog({ _id: session._id }, "Timeout", idle ? new Date(session.lastSeenAt) : session.expiresAt);
      const who = await repo.users.findById(session.userId);
      await writeAudit({ ip: req.ip, headers: req.headers, user: who || {} }, "SessionExpiry", { companyId: who && who.companyId, work: idle ? "idle for " + SESSION_IDLE_MINUTES + " min" : "session expired" });
      return next();
    }
    const user = await repo.users.findOne({ _id: session.userId, active: true });
    if (!user) return next();
    if (session.activeCompanyId && user.hierarchy === "DexterIndiaCompanyTeam" && companyScope(user, session.activeCompanyId)) {
      user.homeCompanyId = user.companyId;
      user.companyId = session.activeCompanyId;
    }
    if (!session.lastSeenAt || now - new Date(session.lastSeenAt) > 60 * 1000) {
      await repo.sessions.updateById(session._id, { $set: { lastSeenAt: now } });
      await repo.session_log.updateById(session._id, { $set: { lastSeenAt: now } });
    }
    req.user = user;
    req.sessionId = session._id;
  } catch (_) {
    /* invalid session */
  }
  next();
}

module.exports = { loadSession };
