const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const { legalCreateGuard } = require("../legal/legal.service");
const { SITE_EXTRA } = require("./sites.model");
const repo = require("./sites.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, applyRecordProject, projectScoped, recordInProject } = require("../../utils/scope");

function siteExtra(b) {
  const out = {};
  SITE_EXTRA.forEach((k) => (out[k] = String(b[k] === undefined ? "" : b[k]).trim()));
  return out;
}

async function getSites(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  applyRecordProject(ctx.user, filter);
  if (projectScoped(ctx.user) && (ctx.user.scopeSiteIds || []).length) filter.siteId = { $in: ctx.user.scopeSiteIds };
  const list = await repo.sites.list(filter, { sort: { siteId: 1 } });
  return { status: 200, body: { sites: list } };
}

async function postSites(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const g = await legalCreateGuard(ctx, companyId);
  if (g.error) return { status: 403, body: { error: g.error } };
  const doc = {
    companyId,
    siteId: String(ctx.body.siteId || "").trim(),
    franchiseId: g.franchiseId,
    applicationId: g.appId,
    projectId: g.projectId,
    address: String(ctx.body.address || ""),
    city: String(ctx.body.city || ""),
    state: String(ctx.body.state || ""),
    pin: String(ctx.body.pin || ""),
    lat: String(ctx.body.lat || ""),
    lng: String(ctx.body.lng || ""),
    ...siteExtra(ctx.body),
    createdAt: new Date(),
  };
  if (!doc.siteId) return { status: 400, body: { error: "siteId required" } };
  if (await repo.sites.findOne({ companyId, siteId: doc.siteId })) return { status: 409, body: { error: "site ID exists" } };
  const result = await repo.sites.insert(doc);
  await writeAudit(ctx, "SiteCreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchSitesById(ctx) {
  const row = await repo.sites.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId) || !recordInProject(ctx.user, row)) return { status: 404, body: { error: "not found" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "office Admin edits sites" } };
  const set = { ...siteExtra(ctx.body) };
  ["address", "city", "state", "pin", "lat", "lng"].forEach((k) => ctx.body[k] !== undefined && (set[k] = String(ctx.body[k]).trim()));
  Object.keys(set).forEach((k) => ctx.body[k] === undefined && delete set[k]);
  if (ctx.body.franchiseId !== undefined) {
    const f = ctx.body.franchiseId ? await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId: row.companyId }) : null;
    if (ctx.body.franchiseId && !f) return { status: 400, body: { error: "franchise not in this company" } };
    set.franchiseId = f ? f._id : null;
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.sites.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "SiteUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true } };
}

module.exports = { siteExtra, getSites, postSites, patchSitesById };
