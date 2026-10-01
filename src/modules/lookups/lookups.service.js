const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const { PHOTO_SLOTS } = require("../applications/applications.model");
const { LOOKUP_SEED } = require("./lookups.model");
const repo = require("./lookups.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter } = require("../../utils/scope");

async function getLookups(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  let row = await repo.lookups.findOne({ companyId });
  if (!row) {
    await seedLookups(companyId);
    row = await repo.lookups.findOne({ companyId });
  }
  const { STAGES, STAGE_STATUSES } = require("../site-projects/site-projects.model");
  const lookups = {
    ...row,
    denos: Array.isArray(row.denos) && row.denos.length ? row.denos : [100, 200, 500, 1000, 2000],
    stageStatuses: Array.isArray(row.stageStatuses) && row.stageStatuses.length ? [...new Set(row.stageStatuses.map((s) => (s === "Completed" ? "Complete" : s)))] : STAGE_STATUSES,
    txnEntryDays: row.txnEntryDays || 45,
  };
  return { status: 200, body: { lookups, photoSlots: PHOTO_SLOTS, stages: STAGES } };
}

async function patchLookups(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId) || !isOfficeAdmin(ctx.user)) {
    return { status: 403, body: { error: "not allowed" } };
  }
  const set = {};
  Object.keys(LOOKUP_SEED).forEach((k) => {
    if (Array.isArray(ctx.body[k])) set[k] = ctx.body[k].map((v) => String(v).trim()).filter(Boolean);
  });
  for (const k of ["stageReminderDays"]) {
    if (ctx.body[k] === undefined) continue;
    const n = Number(ctx.body[k]);
    if (!Number.isInteger(n) || n < 1 || n > 60) return { status: 400, body: { error: k + " must be a whole number of days, 1 to 60" } };
    set[k] = n;
  }
  if (ctx.body.agreementRenewalDays !== undefined) {
    const n = Number(ctx.body.agreementRenewalDays);
    if (!Number.isInteger(n) || n < 1 || n > 180) return { status: 400, body: { error: "agreementRenewalDays must be a whole number of days, 1 to 180" } };
    set.agreementRenewalDays = n;
  }
  for (const k of ["projectAutoTask"]) if (ctx.body[k] !== undefined) set[k] = !!ctx.body[k];
  if (ctx.body.txnEntryDays !== undefined) {
    const n = Number(ctx.body.txnEntryDays);
    if (!Number.isInteger(n) || n < 1 || n > 365) return { status: 400, body: { error: "txnEntryDays must be a whole number of days, 1 to 365" } };
    set.txnEntryDays = n;
  }
  if (ctx.body.denos !== undefined) {
    const all = [100, 200, 500, 1000, 2000];
    const list = (Array.isArray(ctx.body.denos) ? ctx.body.denos : String(ctx.body.denos).split(/[,\s]+/)).map(Number).filter(Boolean);
    if (!list.length || list.some((d) => !all.includes(d))) return { status: 400, body: { error: "denominations must come from " + all.join(", ") } };
    set.denos = [...new Set(list)].sort((a, b) => a - b);
  }
  if (ctx.body.stageStatuses !== undefined) {
    const list = (Array.isArray(ctx.body.stageStatuses) ? ctx.body.stageStatuses : []).map((s) => String(s).trim()).filter(Boolean).map((s) => (s === "Completed" ? "Complete" : s));
    if (!list.includes("Pending") || !list.includes("Complete")) return { status: 400, body: { error: "stage statuses must keep Pending and Complete" } };
    set.stageStatuses = [...new Set(list)];
  }
  if (ctx.body.payoutConfirmEmails !== undefined) {
    const { EMAIL_RE } = require("../mail/mail.model");
    const list = (Array.isArray(ctx.body.payoutConfirmEmails) ? ctx.body.payoutConfirmEmails : String(ctx.body.payoutConfirmEmails).split(/[,;]/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    const bad = list.filter((a) => !EMAIL_RE.test(a));
    if (bad.length) return { status: 400, body: { error: "not an email address: " + bad.join(", ") } };
    if (list.length > 10) return { status: 400, body: { error: "at most 10 addresses" } };
    set.payoutConfirmEmails = [...new Set(list)];
  }
  if (ctx.body.stageOwners !== undefined) {
    if (typeof ctx.body.stageOwners !== "object" || Array.isArray(ctx.body.stageOwners)) return { status: 400, body: { error: "stageOwners must map stage name to owner" } };
    set.stageOwners = Object.fromEntries(Object.entries(ctx.body.stageOwners).map(([k, v]) => [String(k), String(v || "").trim()]));
  }
  if (!Object.keys(set).length) return { status: 400, body: { error: "nothing to change" } };
  await seedLookups(companyId);
  const prev = (await repo.lookups.findOne({ companyId })) || {};
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = prev[k] === undefined ? null : prev[k]));
  await repo.lookups.updateOne({ companyId }, { $set: set });
  await writeAudit(ctx, "LookupChanged", { companyId, module: "CRM-01", before, after: set });
  return { status: 200, body: { ok: true } };
}

async function getReminders(ctx) {
  const companyId = oid(ctx.user.companyId);
  const appFilter = { companyId, status: { $in: ["Submitted", "Approved"] } };
  await applyFranchiseFilter(ctx.user, appFilter, "franchiseId");
  if (ctx.user.hierarchy === "Franchise" && appFilter.franchiseId && appFilter.franchiseId.$in && !appFilter.franchiseId.$in.length) {
    appFilter.createdBy = ctx.user._id;
    delete appFilter.franchiseId;
  }
  const apps = await repo.applications.list(appFilter, { projection: { siteLocationName: 1, model: 1, status: 1 } });
  const withAffidavit = await repo.documents.distinct("parentId", { companyId, type: "Affidavit", parentId: { $in: apps.map((a) => a._id) } });
  const has = new Set(withAffidavit.map(String));
  const affidavitPending = apps.filter((a) => !has.has(String(a._id)));
  return { status: 200, body: { affidavitPending } };
}

async function seedLookups(companyId) {
  const existing = await repo.lookups.findOne({ companyId });
  if (!existing) return repo.lookups.insert({ companyId, ...LOOKUP_SEED, createdAt: new Date() });
  const missing = {};
  Object.keys(LOOKUP_SEED).forEach((k) => existing[k] === undefined && (missing[k] = LOOKUP_SEED[k]));
  const update = Object.keys(missing).length ? { $set: missing } : {};
  if (existing.documentTypes && !existing.signatureTypesAdded) {
    update.$addToSet = { documentTypes: { $each: ["Applicant photo", "Franchise signature"] } };
    update.$set = { ...(update.$set || {}), signatureTypesAdded: true };
  }
  if (Object.keys(update).length) await repo.lookups.updateById(existing._id, update);
}

module.exports = { seedLookups, getLookups, patchLookups, getReminders };
