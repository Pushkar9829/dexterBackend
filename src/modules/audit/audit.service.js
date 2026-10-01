const fs = require("fs");
const path = require("path");
const config = require("../../config/env");
const { can, isOfficeAdmin, companyScope } = require("../../middlewares/rbac");
const { MIN_RETENTION_DAYS, ARCHIVE_DIR, EXPORT_LIMIT, CLIENT_EVENTS, AUTH_EVENTS } = require("./audit.model");
const repo = require("./audit.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { oid } = require("../../utils/ids");

const isAdminLayer = (u) => u.hierarchy === "Admin" || u.hierarchy === "DexterIndiaCompanyTeam";

function canViewAudit(user) {
  return isAdminLayer(user) || user.hierarchy === "Director" || can(user, "Export", "CRM-08");
}

function canViewSessions(user) {
  return isOfficeAdmin(user) || user.hierarchy === "Director";
}

async function policy(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return { retentionDays: Math.max(MIN_RETENTION_DAYS, Number(lu.auditRetentionDays) || MIN_RETENTION_DAYS), hideIpFromNonAdmin: lu.hideIpFromNonAdmin !== false, purgeEnabled: lu.auditPurgeEnabled === true };
}

function maskIp(ip) {
  const s = String(ip || "");
  const v4 = /(\d+)\.(\d+)\.\d+\.\d+$/.exec(s);
  if (v4) return v4[1] + "." + v4[2] + ".x.x";
  return s ? "hidden" : "";
}

function istRange(from, to) {
  const r = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(from || ""))) r.$gte = new Date(from + "T00:00:00+05:30");
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(to || ""))) r.$lte = new Date(to + "T23:59:59.999+05:30");
  return Object.keys(r).length ? r : null;
}

async function grantedCompanyIds(user) {
  if (user.hierarchy !== "DexterIndiaCompanyTeam") return [user.companyId];
  if (user.grantedCompanyIds && user.grantedCompanyIds.length) return user.grantedCompanyIds;
  return [user.homeCompanyId || user.companyId];
}

async function auditFilter(ctx) {
  const q = ctx.query;
  const filter = {};
  if (q.companyId === "all" && ctx.user.hierarchy === "DexterIndiaCompanyTeam") filter.companyId = { $in: await grantedCompanyIds(ctx.user) };
  else if (q.companyId && q.companyId !== "all") {
    if (!companyScope(ctx.user, q.companyId)) return { error: "company scope" };
    filter.companyId = oid(q.companyId);
  } else filter.companyId = oid(ctx.user.companyId);
  const at = istRange(q.from, q.to);
  if (at) filter.at = at;
  if (q.userId) filter.userId = oid(q.userId);
  if (q.login) filter.login = { $regex: String(q.login).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (q.module) filter.module = String(q.module);
  if (q.event) {
    const list = String(q.event)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    filter.event = list.length > 1 ? { $in: list } : list[0];
  }
  if (q.q) filter.work = { $regex: String(q.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (q.recordId) {
    const id = String(q.recordId).trim();
    filter.recordId = /^[a-f0-9]{24}$/i.test(id) ? { $in: [oid(id), id] } : id;
  }
  return { filter };
}

async function showIp(ctx) {
  if (isAdminLayer(ctx.user)) return true;
  return !(await policy(oid(ctx.user.companyId))).hideIpFromNonAdmin;
}

async function archiveAndPurge(filter, label) {
  const rows = await repo.audit_events.list(filter, { sort: { at: 1 } });
  if (!rows.length) return 0;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, "audit-" + label + "-" + new Date().toISOString().slice(0, 10) + ".jsonl");
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await repo.audit_events.deleteMany({ _id: { $in: rows.map((x) => x._id) } });
  return r.deletedCount;
}

async function purgeAudit() {
  const companies = await repo.companies.list({}, { projection: { _id: 1, code: 1 } });
  let removed = 0;
  for (const c of companies) {
    const { retentionDays, purgeEnabled } = await policy(c._id);
    if (!purgeEnabled) continue;
    removed += await archiveAndPurge({ companyId: c._id, at: { $lt: new Date(Date.now() - retentionDays * 86400000) } }, c.code || String(c._id));
  }
  if (config.AUDIT_PURGE_ORPHANS === "on") removed += await archiveAndPurge({ companyId: null, at: { $lt: new Date(Date.now() - MIN_RETENTION_DAYS * 86400000) } }, "no-company");
  return removed;
}

async function expireSession(s, reason, at) {
  await repo.sessions.deleteById(s._id);
  const r = await repo.session_log.updateOne({ _id: s._id, endAt: null }, { $set: { endAt: at, endReason: "Timeout" } });
  if (!r.modifiedCount) return;
  const who = await repo.users.findById(s.userId);
  await writeAudit({ ip: "", headers: {}, user: who || {} }, "SessionExpiry", { companyId: who && who.companyId, work: reason });
}

async function closeStaleSessions(idleMinutes) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - idleMinutes * 60000);
  const stale = await repo.session_log.list({ endAt: null, lastSeenAt: { $lt: cutoff } }, { projection: { _id: 1, userId: 1, lastSeenAt: 1 } });
  for (const s of stale) await expireSession(s, "idle for " + idleMinutes + " min (sweep)", s.lastSeenAt);
  const expired = await repo.sessions.list({ expiresAt: { $lt: now } }, { projection: { _id: 1, userId: 1, expiresAt: 1 } });
  for (const s of expired) await expireSession(s, "session expired (cleanup)", s.expiresAt);
  return stale.length + expired.length;
}

async function startSessionLog(ctx, user, sessionId) {
  await repo.session_log.insert({
    _id: sessionId,
    companyId: user.companyId,
    userId: user._id,
    login: user.login,
    name: user.name,
    hierarchy: user.hierarchy,
    ip: ctx.ip,
    device: String(ctx.headers["user-agent"] || "").slice(0, 200),
    startAt: new Date(),
    lastSeenAt: new Date(),
    endAt: null,
    endReason: null,
  });
}

async function endSessionLog(filter, reason, at) {
  await repo.session_log.updateMany({ ...filter, endAt: null }, { $set: { endAt: at || new Date(), endReason: reason } });
}

function minutes(s, now) {
  const end = s.endAt || s.lastSeenAt || now;
  return Math.max(0, Math.round((new Date(end) - new Date(s.startAt)) / 60000));
}

async function getAudit(ctx) {
  if (!canViewAudit(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const f = await auditFilter(ctx);
  if (f.error) return { status: 403, body: { error: f.error } };
  const pageSize = Math.min(500, Math.max(1, Number(ctx.query.pageSize) || 200));
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const [events, total] = await Promise.all([
    repo.audit_events.list(f.filter, { sort: { at: -1 }, skip: (page - 1) * pageSize, limit: pageSize }),
    repo.audit_events.count(f.filter),
  ]);
  const ipOk = await showIp(ctx);
  return { status: 200, body: { events: ipOk ? events : events.map((e) => ({ ...e, ip: maskIp(e.ip) })), total, page, pageSize, ipMasked: !ipOk } };
}

async function getAuditMeta(ctx) {
  if (!canViewAudit(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const companyIds = await grantedCompanyIds(ctx.user);
  const scope = { companyId: oid(ctx.user.companyId) };
  const [events, modules, users, companies] = await Promise.all([
    repo.audit_events.distinct("event", scope),
    repo.audit_events.distinct("module", scope),
    repo.users.list(scope, { projection: { login: 1, name: 1 }, sort: { name: 1 } }),
    repo.companies.list({ _id: { $in: companyIds } }, { projection: { name: 1, code: 1 } }),
  ]);
  return { status: 200, body: {
    events: events.sort(),
    modules: modules.filter(Boolean).sort(),
    users,
    companies,
    canExport: isAdminLayer(ctx.user),
    canSettings: isAdminLayer(ctx.user),
    crossCompany: ctx.user.hierarchy === "DexterIndiaCompanyTeam",
    policy: await policy(oid(ctx.user.companyId)),
  } };
}

async function getAuditExport(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "audit export is Admin / Dexter India / Company Team" } };
  const f = await auditFilter(ctx);
  if (f.error) return { status: 403, body: { error: f.error } };
  const rows = await repo.audit_events.list(f.filter, { sort: { at: -1 }, limit: EXPORT_LIMIT });
  const codes = new Map((await repo.companies.list({}, { projection: { code: 1 } })).map((c) => [String(c._id), c.code]));
  const json = (v) => (v ? JSON.stringify(v).slice(0, 2000) : "");
  const ist = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().replace("T", " ").slice(0, 19);
  const head = ["at_ist", "event", "login", "company", "module", "recordId", "ip", "device", "work", "before", "after"];
  const lines = [head.join(",")];
  rows.forEach((e) =>
    lines.push([ist(e.at), e.event, e.login, codes.get(String(e.companyId)) || "", e.module, e.recordId ? String(e.recordId) : "", e.ip, e.device, e.work, json(e.before), json(e.after)].map(csvCell).join(","))
  );
  await writeAudit(ctx, "AuditExported", { module: "CRM-08", work: rows.length + " rows " + JSON.stringify(ctx.query) });
  return { status: 200, body: { fileName: "audit-" + new Date().toISOString().slice(0, 10) + ".csv", csv: "\uFEFF" + lines.join("\n"), rows: rows.length, truncated: rows.length === EXPORT_LIMIT } };
}

async function patchAuditSettings(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "Admin / Dexter India only" } };
  const companyId = oid(ctx.user.companyId);
  const set = {};
  if (ctx.body.retentionDays !== undefined) {
    const d = Number(ctx.body.retentionDays);
    if (!Number.isInteger(d) || d < MIN_RETENTION_DAYS) return { status: 400, body: { error: "retention must be a whole number of days, at least " + MIN_RETENTION_DAYS } };
    set.auditRetentionDays = d;
  }
  if (ctx.body.hideIpFromNonAdmin !== undefined) set.hideIpFromNonAdmin = !!ctx.body.hideIpFromNonAdmin;
  if (ctx.body.purgeEnabled !== undefined) set.auditPurgeEnabled = !!ctx.body.purgeEnabled;
  if (!Object.keys(set).length) return { status: 400, body: { error: "nothing to change" } };
  const before = await policy(companyId);
  await repo.lookups.updateOne({ companyId }, { $set: set }, { upsert: true });
  await writeAudit(ctx, "AuditSettingsChanged", { companyId, module: "CRM-08", before, after: set });
  return { status: 200, body: { ok: true } };
}

async function postAuditClientEvent(ctx) {
  const event = CLIENT_EVENTS[ctx.body.kind];
  if (!event) return { status: 400, body: { error: "kind must be one of " + Object.keys(CLIENT_EVENTS).join(", ") } };
  const page = String(ctx.body.page || "").slice(0, 60);
  const recent = await repo.audit_events.findOne({ userId: ctx.user._id, event, at: { $gt: new Date(Date.now() - 30000) } });
  if (recent) return { status: 200, body: { ok: true, deduped: true } };
  await writeAudit(ctx, event, { companyId: ctx.user.companyId, module: "CRM-08", work: page ? "page " + page : "" });
  return { status: 200, body: { ok: true } };
}

async function getAnalyticsSessions(ctx) {
  const mine = ctx.query.view === "mine";
  if (!mine && !canViewSessions(ctx.user)) return { status: 403, body: { error: "office Admin / Director only" } };
  const companyId = oid(ctx.user.companyId);
  const now = new Date();
  const range = istRange(ctx.query.from, ctx.query.to) || { $gte: new Date(now.getTime() - 30 * 86400000) };
  const sf = { companyId, startAt: range };
  if (mine) sf.userId = ctx.user._id;
  else if (ctx.query.userId) sf.userId = oid(ctx.query.userId);
  const sessions = await repo.session_log.list(sf);
  const userIds = mine ? [ctx.user._id] : sf.userId ? [sf.userId] : [...new Set(sessions.map((s) => String(s.userId)))].map(oid);
  const users = await repo.users.list({ _id: { $in: userIds } }, { projection: { login: 1, name: 1, hierarchy: 1, functionalRole: 1 } });
  const [failures, work, tasksDone] = await Promise.all([
    repo.audit_events
      .aggregate([{ $match: { companyId, event: "LoginFailure", at: range, login: { $in: users.map((u) => u.login) } } }, { $group: { _id: "$login", n: { $sum: 1 } } }])
      .toArray(),
    repo.audit_events
      .aggregate([
        { $match: { companyId, at: range, userId: { $in: userIds }, event: { $nin: AUTH_EVENTS } } },
        { $group: { _id: { u: "$userId", m: "$module" }, n: { $sum: 1 } } },
      ])
      .toArray(),
    repo.tasks
      .aggregate([{ $match: { companyId, assigneeId: { $in: userIds }, completedAt: range } }, { $group: { _id: "$assigneeId", n: { $sum: 1 } } }])
      .toArray(),
  ]);
  const ipOk = await showIp(ctx);
  const failBy = new Map(failures.map((f) => [f._id, f.n]));
  const doneBy = new Map(tasksDone.map((t) => [String(t._id), t.n]));
  const rows = users.map((u) => {
    const mineS = sessions.filter((s) => String(s.userId) === String(u._id)).sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
    const total = mineS.reduce((s, x) => s + minutes(x, now), 0);
    const workRows = work.filter((w) => String(w._id.u) === String(u._id));
    const last = mineS[0];
    const lastLogout = mineS.find((s) => s.endReason === "Logout");
    return {
      userId: String(u._id),
      name: u.name,
      login: u.login,
      role: u.functionalRole || u.hierarchy,
      logins: mineS.length,
      logouts: mineS.filter((s) => s.endReason === "Logout").length,
      timeouts: mineS.filter((s) => s.endReason === "Timeout").length,
      openSessions: mineS.filter((s) => !s.endAt).length,
      failures: failBy.get(u.login) || 0,
      totalMinutes: total,
      avgMinutes: mineS.length ? Math.round(total / mineS.length) : 0,
      lastLogin: last ? last.startAt : null,
      lastLogout: lastLogout ? lastLogout.endAt : null,
      lastIp: last ? (ipOk ? last.ip : maskIp(last.ip)) : "",
      workEvents: workRows.reduce((s, w) => s + w.n, 0),
      ticketActions: workRows.filter((w) => w._id.m === "CRM-05").reduce((s, w) => s + w.n, 0),
      tasksCompleted: doneBy.get(String(u._id)) || 0,
    };
  });
  rows.sort((a, b) => b.logins - a.logins || String(a.name).localeCompare(String(b.name)));
  return { status: 200, body: { rows, ipMasked: !ipOk, note: "Login time and session length are shown for context only. They are not a measure of productivity; see the work events next to them." } };
}

async function getAnalyticsSessionsByUserId(ctx) {
  const own = String(ctx.params.userId) === String(ctx.user._id);
  if (!own && !canViewSessions(ctx.user)) return { status: 403, body: { error: "office Admin / Director only" } };
  const now = new Date();
  const list = await repo.session_log.list({ companyId: oid(ctx.user.companyId), userId: oid(ctx.params.userId) }, { sort: { startAt: -1 }, limit: 100 });
  const ipOk = await showIp(ctx);
  return { status: 200, body: { canRevoke: isOfficeAdmin(ctx.user) || own, sessions: list.map((s) => ({ id: String(s._id), current: String(s._id) === String(ctx.sessionId), startAt: s.startAt, endAt: s.endAt, endReason: s.endReason || (s.endAt ? "" : "Open"), lastSeenAt: s.lastSeenAt, minutes: minutes(s, now), ip: ipOk ? s.ip : maskIp(s.ip), device: s.device })) } };
}

// ends the session at once: the token stops resolving on the next request
async function deleteAnalyticsSessionsBySessionId(ctx) {
  const id = oid(ctx.params.sessionId);
  if (!id) return { status: 400, body: { error: "bad session id" } };
  const s = await repo.session_log.findById(id);
  if (!s || !companyScope(ctx.user, s.companyId)) return { status: 404, body: { error: "session not found" } };
  const own = String(s.userId) === String(ctx.user._id);
  if (!own && !isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "office Admin only" } };
  if (String(id) === String(ctx.sessionId)) return { status: 400, body: { error: "this is your current session; use Logout" } };
  if (s.endAt) return { status: 400, body: { error: "session already ended (" + (s.endReason || "closed") + ")" } };
  await repo.sessions.deleteById(id);
  await endSessionLog({ _id: id }, "Revoked");
  await writeAudit(ctx, "SessionRevoked", { companyId: s.companyId, module: "CRM-01", recordId: s.userId, work: s.login + " session from " + (s.ip || "?") + " started " + new Date(s.startAt).toISOString() });
  return { status: 200, body: { ok: true } };
}

module.exports = { deleteAnalyticsSessionsBySessionId, isAdminLayer, canViewAudit, canViewSessions, policy, maskIp, istRange, grantedCompanyIds, auditFilter, showIp, archiveAndPurge, purgeAudit, expireSession, closeStaleSessions, startSessionLog, endSessionLog, minutes, getAudit, getAuditMeta, getAuditExport, patchAuditSettings, postAuditClientEvent, getAnalyticsSessions, getAnalyticsSessionsByUserId };
