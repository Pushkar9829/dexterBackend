const { canSetLinkShared, canApproveApplication, can } = require("../../middlewares/rbac");
const { canTouchApplication } = require("../applications/applications.service");
const { DECISION_STATUSES, FRANCHISE_SETTABLE, LEGAL_STATUSES, LEGAL_DECIDED } = require("./legal.model");
const repo = require("./legal.repository");
const { storeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, inFranchiseScope, defaultProjectId, recordInProject } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

async function legalCreateGuard(ctx, companyId) {
  const appId = ctx.body.applicationId ? oid(ctx.body.applicationId) : null;
  let appRow = null;
  if (appId) {
    appRow = await repo.applications.findOne({ _id: appId, companyId });
    if (!appRow) return { error: "application not found" };
    if (!(await canTouchApplication(ctx.user, appRow))) return { error: "own records only" };
  }
  let franchiseId = ctx.body.franchiseId ? oid(ctx.body.franchiseId) : null;
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) {
    if (!franchiseId || !(await inFranchiseScope(ctx.user, franchiseId))) franchiseId = ctx.user.franchiseId || null;
  } else if (franchiseId && !(await repo.franchises.findOne({ _id: franchiseId, companyId }))) {
    return { error: "franchise not in this company" };
  }
  const proj = appRow && appRow.projectId ? { projectId: appRow.projectId } : await defaultProjectId(ctx.user, companyId, ctx.body.projectId);
  if (proj.error) return { error: proj.error };
  return { appId, franchiseId, projectId: proj.projectId };
}

async function checkExtra(companyId, register, incoming, current, owner) {
  if (incoming !== undefined && (typeof incoming !== "object" || incoming === null || Array.isArray(incoming))) return { error: "extra must be an object of column: value" };
  const cols = await repo.register_columns.list({ companyId, register });
  const byName = new Map(cols.map((c) => [c.name, c]));
  const out = { ...(current || {}) };
  for (const [k, raw] of Object.entries(incoming || {})) {
    const c = byName.get(k);
    if (!c) return { error: "unknown column '" + k + "' on " + register };
    if (c.type === "file" && raw && typeof raw === "object") {
      if (!owner || !owner.parentId) return { error: k + ": save the record first, then attach the file" };
      const f = checkFile(raw.fileName, raw.data);
      if (f.error) return { error: k + ": " + f.error };
      const doc = { companyId, parentType: "register:" + register, parentId: owner.parentId, type: "Column: " + k, version: 1, fileName: f.name, mime: f.mime, ...(await storeFile(f.data, f.name, f.mime)), franchiseId: owner.franchiseId || null, uploadedBy: owner.userId, uploadedAt: new Date() };
      const r = await repo.documents.insert(doc);
      out[k] = { docId: String(r.insertedId), fileName: f.name };
      continue;
    }
    const v = raw === null || raw === undefined ? "" : String(raw).trim();
    if (v && c.type === "number" && !Number.isFinite(Number(v.replace(/,/g, "")))) return { error: k + " must be a number" };
    if (v && c.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: k + " must be a date YYYY-MM-DD" };
    if (v && c.type === "status" && (c.options || []).length && !c.options.includes(v)) return { error: k + " must be one of " + c.options.join(", ") };
    if (v && c.type === "file") return { error: k + " takes a file upload" };
    out[k] = c.type === "number" && v ? Number(v.replace(/,/g, "")) : v;
  }
  const missing = cols.filter((c) => c.required && (out[c.name] === undefined || out[c.name] === "")).map((c) => c.name);
  if (missing.length) return { error: "required column" + (missing.length > 1 ? "s" : "") + " missing: " + missing.join(", ") };
  return { extra: out };
}

async function legalPatchGuard(ctx, row) {
  if (!(await inFranchiseScope(ctx.user, row.franchiseId))) return "own records only";
  if (!recordInProject(ctx.user, row)) return "outside your projects";
  if (ctx.body.extra && FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return "extra columns are office-only";
  const target = ctx.body.approve ? "Approved" : ctx.body.reject ? "Rejected" : ctx.body.status;
  const decision = !!target && (DECISION_STATUSES.includes(target) || target === "Link Shared");
  if (!decision && !can(ctx.user, "Edit", "CRM-02")) return "Edit action not granted";
  if (!target) return null;
  if (target === "Link Shared") return canSetLinkShared(ctx.user) ? null : "only Admin or Sales Officer";
  if (DECISION_STATUSES.includes(target)) {
    return canApproveApplication(ctx.user) ? null : "only Verifier / Admin can decide";
  }
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy) && !FRANCHISE_SETTABLE.includes(target)) return "status not allowed";
  return null;
}

async function legalTarget(ctx, row, parentType) {
  const target = ctx.body.approve ? "Approved" : ctx.body.reject ? "Rejected" : ctx.body.status ? String(ctx.body.status) : "";
  if (!target || target === row.status) return {};
  if (!LEGAL_STATUSES.includes(target)) return { error: "status must be one of " + LEGAL_STATUSES.join(", ") };
  if (target === "Terminated" && (parentType !== "agreement" || row.status !== "Approved")) return { error: "only an approved agreement can be terminated" };
  if (LEGAL_DECIDED.includes(row.status)) {
    if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { error: "already " + row.status + "; only Admin can change the decision" };
    if (!String(ctx.body.reason || "").trim()) return { error: "reason required to override a decision" };
  }
  if (target === "Uploaded" && !(await repo.documents.findOne({ companyId: row.companyId, parentType, parentId: row._id }))) {
    return { error: "upload the file first" };
  }
  return { status: target, override: LEGAL_DECIDED.includes(row.status) };
}

function stripFile(doc) {
  if (!doc) return doc;
  const { data, ...rest } = doc;
  rest.hasFile = !!data;
  return rest;
}

module.exports = { legalCreateGuard, checkExtra, legalPatchGuard, legalTarget, stripFile };
