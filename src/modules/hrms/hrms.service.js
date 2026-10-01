const crypto = require("crypto");
const { logRun } = require("../../adapters/common");
const config = require("../../config/env");
const { EMAIL_RE, LEFT, SYSTEM_REQ, MODE } = require("./hrms.model");
const repo = require("./hrms.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

async function hrmsCompany() {
  const v = String(config.HRMS_COMPANY || "").trim();
  if (!v) return null;
  return (oid(v) && (await repo.companies.findById(oid(v)))) || (await repo.companies.findOne({ code: v }));
}

function clean(e) {
  const employeeId = String(e.employeeId || e.employee_id || e.id || "").trim();
  const email = String(e.email || "").trim().toLowerCase();
  const status = String(e.status || (e.active === false ? "inactive" : "active")).toLowerCase();
  return {
    employeeId,
    name: String(e.name || e.fullName || "").trim(),
    email: EMAIL_RE.test(email) ? email : "",
    mobile: String(e.mobile || e.phone || "").replace(/[^\d+]/g, ""),
    team: String(e.department || e.team || "").trim(),
    designation: String(e.designation || e.title || "").trim(),
    left: LEFT.includes(status),
  };
}

// Never activates a login and never touches hierarchy, grants, MFA or company.
async function applyEmployees(company, list, source) {
  const companyId = company._id;
  const out = { created: 0, updated: 0, deactivated: 0, unchanged: 0, errors: [] };
  for (const raw of Array.isArray(list) ? list : []) {
    const e = clean(raw || {});
    if (!e.employeeId) {
      out.errors.push("row without employeeId");
      continue;
    }
    const user = await repo.users.findOne({ companyId, hrmsEmployeeId: e.employeeId });
    if (!user) {
      if (e.left) {
        out.unchanged++;
        continue;
      }
      if (!e.email || !e.name) {
        out.errors.push(e.employeeId + ": name and email needed to create");
        continue;
      }
      if (await repo.users.findOne({ login: e.email })) {
        out.errors.push(e.employeeId + ": login " + e.email + " already exists");
        continue;
      }
      const doc = { login: e.email, name: e.name, email: e.email, mobile: e.mobile, team: e.team, designation: e.designation, active: false, hierarchy: "SubAdmin", functionalRole: "", companyId, projectIds: [], recordScope: "own", scopeAtmIds: [], scopeSiteIds: [], franchiseId: null, grantedCompanyIds: [companyId], actions: [], modules: [], passwordSalt: null, passwordHash: null, mfaRequired: true, hrmsEmployeeId: e.employeeId, hrmsSyncedAt: new Date(), createdAt: new Date(), createdBy: null };
      const r = await repo.users.insert(doc);
      await writeAudit(SYSTEM_REQ, "HrmsEmployeeCreated", { companyId, module: "CRM-01", recordId: r.insertedId, after: { login: e.email, hrmsEmployeeId: e.employeeId, active: false }, work: source });
      out.created++;
      continue;
    }
    const set = {};
    ["name", "mobile", "team", "designation"].forEach((k) => {
      if (e[k] && e[k] !== (user[k] || "")) set[k] = e[k];
    });
    if (e.email && e.email !== (user.email || "")) set.email = e.email;
    if (e.left && user.active) set.active = false;
    if (!Object.keys(set).length) {
      out.unchanged++;
      continue;
    }
    const before = Object.fromEntries(Object.keys(set).map((k) => [k, user[k] === undefined ? null : user[k]]));
    await repo.users.updateById(user._id, { $set: { ...set, hrmsSyncedAt: new Date() } });
    if (set.active === false) {
      await repo.sessions.deleteMany({ userId: user._id });
      out.deactivated++;
      await writeAudit(SYSTEM_REQ, "HrmsEmployeeDeactivated", { companyId, module: "CRM-01", recordId: user._id, before, after: set, work: source });
    } else {
      out.updated++;
      await writeAudit(SYSTEM_REQ, "HrmsEmployeeUpdated", { companyId, module: "CRM-01", recordId: user._id, before, after: set, work: source });
    }
  }
  await writeAudit(SYSTEM_REQ, "HrmsSync", { companyId, module: "CRM-01", work: source + ": " + out.created + " created, " + out.updated + " updated, " + out.deactivated + " deactivated, " + out.unchanged + " unchanged, " + out.errors.length + " errors" });
  return out;
}

async function pullOnce() {
  if (MODE() !== "pull") return { ok: false, message: "not configured (HRMS_ADAPTER is " + MODE() + ")" };
  const company = await hrmsCompany();
  if (!config.HRMS_URL || !company) return { ok: false, message: "not configured (HRMS_URL and HRMS_COMPANY needed)" };
  const r = await fetch(config.HRMS_URL, { headers: config.HRMS_TOKEN ? { authorization: "Bearer " + config.HRMS_TOKEN } : {}, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HRMS HTTP " + r.status);
  const body = await r.json();
  const out = await applyEmployees(company, Array.isArray(body) ? body : body.employees, "pull");
  return { ok: true, message: out.created + " created, " + out.updated + " updated, " + out.deactivated + " deactivated", ...out };
}

function verifySignature(secret, req) {
  const ts = String(req.headers["x-af-timestamp"] || "");
  const sig = String(req.headers["x-af-signature"] || "").replace(/^sha256=/, "");
  if (!secret || !ts || !sig || !req.rawBody) return false;
  if (Math.abs(Date.now() - Number(ts) * 1000) > 5 * 60 * 1000) return false;
  const want = crypto.createHmac("sha256", secret).update(ts + "." + req.rawBody.toString("utf8")).digest("hex");
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

async function postHrmsWebhook(ctx) {
  if (MODE() !== "webhook") return { status: 404, body: { error: "not found" } };
  if (!verifySignature(config.HRMS_WEBHOOK_SECRET, ctx)) return { status: 401, body: { error: "bad signature" } };
  const company = await hrmsCompany();
  if (!company) return { status: 503, body: { error: "HRMS_COMPANY not set" } };
  const list = Array.isArray(ctx.body.employees) ? ctx.body.employees : [ctx.body];
  const out = await applyEmployees(company, list, "webhook");
  await logRun("hrms", true, out.created + " created, " + out.updated + " updated, " + out.deactivated + " deactivated");
  return { status: 200, body: out };
}

module.exports = { hrmsCompany, clean, applyEmployees, pullOnce, verifySignature, postHrmsWebhook };
