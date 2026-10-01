const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const { legalCreateGuard, legalPatchGuard, legalTarget, checkExtra } = require("../legal/legal.service");
const repo = require("./lois.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, applyRecordProject } = require("../../utils/scope");

async function getLois(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  applyRecordProject(ctx.user, filter);
  const list = await repo.lois.list(filter, { sort: { createdAt: -1 } });
  return { status: 200, body: { lois: list } };
}

async function postLois(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const g = await legalCreateGuard(ctx, companyId);
  if (g.error) return { status: 403, body: { error: g.error } };
  const doc = {
    companyId,
    loiCode: String(ctx.body.loiCode || "").trim(),
    applicationId: g.appId,
    siteId: ctx.body.siteId ? oid(ctx.body.siteId) : null,
    franchiseId: g.franchiseId,
    projectId: g.projectId,
    status: "Pending",
    createdAt: new Date(),
  };
  if (!doc.loiCode) return { status: 400, body: { error: "loiCode required" } };
  const result = await repo.lois.insert(doc);
  await writeAudit(ctx, "LOICreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchLoisById(ctx) {
  const row = await repo.lois.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const denied = await legalPatchGuard(ctx, row);
  if (denied) return { status: 403, body: { error: denied } };
  const t = await legalTarget(ctx, row, "loi");
  if (t.error) return { status: 400, body: { error: t.error } };
  const set = { updatedAt: new Date() };
  if (t.status) set.status = t.status;
  if (ctx.body.extra) {
    const x = await checkExtra(row.companyId, "loi", ctx.body.extra, row.extra, { parentId: row._id, userId: ctx.user._id, franchiseId: row.franchiseId });
    if (x.error) return { status: 400, body: { error: x.error } };
    set.extra = x.extra;
  }
  if (ctx.body.loiDate !== undefined && isOfficeAdmin(ctx.user)) set.loiDate = String(ctx.body.loiDate || "").slice(0, 10);
  await repo.lois.updateById(row._id, { $set: set });
  await writeAudit(ctx, "LOIUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before: { status: row.status, loiDate: row.loiDate || null, extra: row.extra || null }, after: set, work: t.override ? "Admin override: " + String(ctx.body.reason) : "" });
  return { status: 200, body: { ok: true } };
}

module.exports = { getLois, postLois, patchLoisById };
