const { companyScope } = require("../../middlewares/rbac");
const { endSessionLog } = require("../audit/audit.service");
const { MOVABLE } = require("./companies.model");
const repo = require("./companies.repository");
const { seedLookups } = require("../lookups/lookups.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { DONE: COMPLAINT_DONE } = require("../complaints/complaints.model");
const { DONE: TASK_DONE } = require("../tasks/tasks.model");

// Records that would be left behind in the old company, pointing at the moved one. The move is refused until they
// are moved or reassigned.
async function moveBlockers(type, row) {
  const companyId = row.companyId;
  const count = (name, filter) => repo.collection(name).count({ companyId, ...filter });
  const checks = {
    user: [
      ["open tasks", "tasks", { assigneeId: row._id, status: { $nin: TASK_DONE } }],
      ["open complaints", "complaints", { ownerUserId: row._id, status: { $nin: COMPLAINT_DONE } }],
      ["open visits", "visits", { officerId: row._id, open: true }],
    ],
    franchise: [
      ["child franchises", "franchises", { $or: [{ masterId: row._id }, { superMasterId: row._id }] }],
      ["ATMs", "atms", { franchiseId: row._id }],
      ["logins", "users", { franchiseId: row._id }],
      ["applications", "applications", { franchiseId: row._id }],
    ],
    atm: [
      ["open complaints", "complaints", { atmId: row.atmId, status: { $nin: COMPLAINT_DONE } }],
      ["projects", "site_projects", { atmId: row.atmId }],
    ],
    application: [
      ["LOIs", "lois", { applicationId: row._id }],
      ["agreements", "agreements", { applicationId: row._id }],
      ["projects", "site_projects", { applicationId: row._id }],
    ],
  };
  const out = [];
  for (const [label, name, filter] of checks[type] || []) {
    const n = await count(name, filter);
    if (n) out.push(n + " " + label);
  }
  return out;
}

async function getCompanies(ctx) {
  const filter = {};
  if (ctx.user.hierarchy !== "DexterIndiaCompanyTeam") {
    filter._id = ctx.user.companyId;
  } else {
    filter._id = { $in: ctx.user.grantedCompanyIds && ctx.user.grantedCompanyIds.length ? ctx.user.grantedCompanyIds : [ctx.user.homeCompanyId || ctx.user.companyId] };
  }
  const list = await repo.companies.list(filter, { sort: { name: 1 } });
  return { status: 200, body: { companies: list } };
}

async function postCompanies(ctx) {
  if (ctx.user.hierarchy !== "DexterIndiaCompanyTeam" && ctx.user.hierarchy !== "Admin") {
    return { status: 403, body: { error: "not allowed" } };
  }
  if (ctx.user.hierarchy === "Admin") {
    return { status: 403, body: { error: "only Dexter India / Company Team creates companies" } };
  }
  const name = String(ctx.body.name || "").trim();
  const code = String(ctx.body.code || "").trim().toUpperCase();
  if (!name || !code) return { status: 400, body: { error: "name and code required" } };
  const doc = { name, code, active: true, indiaOperating: true, createdAt: new Date() };
  const result = await repo.companies.insert(doc);
  await seedLookups(result.insertedId);
  const held = ctx.user.grantedCompanyIds && ctx.user.grantedCompanyIds.length ? ctx.user.grantedCompanyIds : [ctx.user.homeCompanyId || ctx.user.companyId];
  await repo.users.updateById(ctx.user._id, { $set: { grantedCompanyIds: [...held, result.insertedId] } });
  await writeAudit(ctx, "CompanyCreated", { companyId: result.insertedId, module: "CRM-01", after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchCompaniesById(ctx) {
  if (ctx.user.hierarchy !== "DexterIndiaCompanyTeam") return { status: 403, body: { error: "only Dexter India / Company Team edits companies" } };
  const row = await repo.companies.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row._id)) return { status: 404, body: { error: "not found" } };
  const set = {};
  if (ctx.body.name !== undefined) {
    set.name = String(ctx.body.name).trim();
    if (!set.name) return { status: 400, body: { error: "name required" } };
  }
  if (ctx.body.indiaOperating !== undefined) set.indiaOperating = !!ctx.body.indiaOperating;
  if (ctx.body.active !== undefined) {
    set.active = !!ctx.body.active;
    if (!set.active && String(row._id) === String(ctx.user.homeCompanyId || ctx.user.companyId)) return { status: 400, body: { error: "cannot deactivate your own home company" } };
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.companies.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  if (set.active === false) {
    const ids = (await repo.users.list({ companyId: row._id }, { projection: { _id: 1 } })).map((u) => u._id);
    await repo.sessions.deleteMany({ userId: { $in: ids } });
    await endSessionLog({ userId: { $in: ids } }, "Company deactivated");
    await repo.sessions.updateMany({ activeCompanyId: row._id }, { $unset: { activeCompanyId: "" } });
    await repo.collection("session_log").updateMany({ activeCompanyId: row._id, endAt: null }, { $unset: { activeCompanyId: "" } });
  }
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, set.active === false ? "CompanyDeactivated" : "CompanyUpdated", { companyId: row._id, module: "CRM-01", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true } };
}

async function patchCompaniesByIdSecurity(ctx) {
  if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "Admin sets company security" } };
  const row = await repo.companies.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row._id)) return { status: 404, body: { error: "not found" } };
  const set = {};
  if (ctx.body.mfaRelaxFranchise !== undefined) set.mfaRelaxFranchise = !!ctx.body.mfaRelaxFranchise;
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.companies.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  await writeAudit(ctx, "MfaPolicyChanged", { companyId: row._id, module: "CRM-01", recordId: row._id, before: { mfaRelaxFranchise: !!row.mfaRelaxFranchise }, after: set });
  return { status: 200, body: { ok: true } };
}

async function postCompanyMove(ctx) {
  if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "only Admin / Dexter India moves records between companies" } };
  const kind = MOVABLE[ctx.body.type];
  if (!kind) return { status: 400, body: { error: "type must be one of " + Object.keys(MOVABLE).join(", ") } };
  const row = await repo.collection(kind.name).findById(oid(ctx.body.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const target = await repo.companies.findById(oid(ctx.body.targetCompanyId));
  if (!target || target.active === false) return { status: 400, body: { error: "target company not found or inactive" } };
  if (!companyScope(ctx.user, target._id)) return { status: 403, body: { error: "you do not hold the target company" } };
  if (String(target._id) === String(row.companyId)) return { status: 400, body: { error: "already in that company" } };
  const reason = String(ctx.body.reason || "").trim();
  if (!reason) return { status: 400, body: { error: "reason required" } };
  if (ctx.body.type === "user" && String(row._id) === String(ctx.user._id)) return { status: 400, body: { error: "you cannot move yourself" } };
  if (ctx.body.type === "atm" && (await repo.atms.findOne({ companyId: target._id, atmId: row.atmId }))) return { status: 409, body: { error: "target company already has ATM " + row.atmId } };
  const blockers = await moveBlockers(ctx.body.type, row);
  if (blockers.length) return { status: 409, body: { error: "move or reassign these first: " + blockers.join(", ") } };
  const set = { companyId: target._id, updatedAt: new Date() };
  for (const k of kind.clear) set[k] = k === "grantedCompanyIds" ? [target._id] : k === "projectIds" ? [] : null;
  if (ctx.body.type === "user" && row.hierarchy === "DexterIndiaCompanyTeam") {
    const grants = (row.grantedCompanyIds && row.grantedCompanyIds.length ? row.grantedCompanyIds : [row.companyId]).map(String);
    set.grantedCompanyIds = [...new Set([...grants, String(target._id)])].map(oid);
  }
  const before = { companyId: row.companyId };
  kind.clear.forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await repo.collection(kind.name).updateById(row._id, { $set: set });
  if (ctx.body.type === "application") {
    await repo.collection("documents").updateMany({ companyId: row.companyId, parentType: { $in: ["application", null] }, parentId: row._id }, { $set: { companyId: target._id, franchiseId: null } });
  }
  if (ctx.body.type === "user") {
    await repo.sessions.deleteMany({ userId: row._id });
    await endSessionLog({ userId: row._id }, "Company moved");
  }
  const work = ctx.body.type + " " + kind.label(row) + " moved to " + target.name + ": " + reason;
  await writeAudit(ctx, "CompanyMoved", { companyId: row.companyId, module: "CRM-01", recordId: row._id, before, after: set, work });
  await writeAudit(ctx, "CompanyMoved", { companyId: target._id, module: "CRM-01", recordId: row._id, before, after: set, work });
  return { status: 200, body: { ok: true } };
}

module.exports = { getCompanies, postCompanies, patchCompaniesById, patchCompaniesByIdSecurity, postCompanyMove };
