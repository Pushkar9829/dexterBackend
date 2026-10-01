const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const repo = require("./apna.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter } = require("../../utils/scope");

async function getApna(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  const list = await repo.apna_mappings.list(filter);
  return { status: 200, body: { mappings: list } };
}

async function postApna(ctx) {
  if (!isOfficeAdmin(ctx.user) && ctx.user.functionalRole !== "ServiceProjectOps") {
    return { status: 403, body: { error: "not allowed" } };
  }
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (ctx.body.franchiseId && !(await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId }))) {
    return { status: 400, body: { error: "franchise not in this company" } };
  }
  const doc = {
    companyId,
    siteLoi: String(ctx.body.siteLoi || ""),
    atmId: String(ctx.body.atmId || ""),
    location: String(ctx.body.location || ""),
    franchiseeName: String(ctx.body.franchiseeName || ""),
    franchiseeContact: String(ctx.body.franchiseeContact || ""),
    franchiseeEmail: String(ctx.body.franchiseeEmail || ""),
    masterFranchise: String(ctx.body.masterFranchise || ""),
    masterContact: String(ctx.body.masterContact || ""),
    masterEmail: String(ctx.body.masterEmail || ""),
    franchiseId: ctx.body.franchiseId ? oid(ctx.body.franchiseId) : null,
    createdAt: new Date(),
  };
  const result = await repo.apna_mappings.insert(doc);
  await writeAudit(ctx, "ApnaMappingCreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchApnaById(ctx) {
  if (!isOfficeAdmin(ctx.user) && ctx.user.functionalRole !== "ServiceProjectOps") return { status: 403, body: { error: "not allowed" } };
  const row = await repo.apna_mappings.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const set = {};
  ["siteLoi", "atmId", "location", "franchiseeName", "franchiseeContact", "franchiseeEmail", "masterFranchise", "masterContact", "masterEmail"].forEach((k) => ctx.body[k] !== undefined && (set[k] = String(ctx.body[k]).trim()));
  if (ctx.body.franchiseId !== undefined) {
    const f = ctx.body.franchiseId ? await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId: row.companyId }) : null;
    if (ctx.body.franchiseId && !f) return { status: 400, body: { error: "franchise not in this company" } };
    set.franchiseId = f ? f._id : null;
  }
  if (ctx.body.active !== undefined) set.active = !!ctx.body.active;
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.apna_mappings.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "ApnaMappingUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true } };
}

module.exports = { getApna, postApna, patchApnaById };
