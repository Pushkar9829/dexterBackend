const { companyScope } = require("../../middlewares/rbac");
const repo = require("./projects.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

async function patchProjectsById(ctx) {
  const row = await repo.projects.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "Admin edits projects" } };
  const set = {};
  if (ctx.body.name !== undefined) {
    set.name = String(ctx.body.name).trim();
    if (!set.name) return { status: 400, body: { error: "name required" } };
  }
  if (ctx.body.active !== undefined) set.active = !!ctx.body.active;
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.projects.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "ProjectUpdated", { companyId: row.companyId, module: "CRM-01", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true } };
}

async function getProjects(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const list = await repo.projects.list({ companyId }, { sort: { name: 1 } });
  return { status: 200, body: { projects: list } };
}

async function postProjects(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "Admin creates projects" } };
  const name = String(ctx.body.name || "").trim();
  if (!name) return { status: 400, body: { error: "name required" } };
  const doc = { companyId, name, active: true, createdAt: new Date() };
  const result = await repo.projects.insert(doc);
  await writeAudit(ctx, "ProjectCreated", { companyId, module: "CRM-01", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function backfillProjects() {
  const byCompany = {};
  for (const p of await repo.projects.list({}, { projection: { companyId: 1 }, sort: { createdAt: 1, _id: 1 } })) {
    const k = String(p.companyId);
    if (!(k in byCompany)) byCompany[k] = p._id;
  }
  for (const [companyId, projectId] of Object.entries(byCompany)) {
    for (const name of ["applications", "sites", "lois", "agreements", "site_projects"]) {
      await repo.collection(name).updateMany({ companyId: oid(companyId), $or: [{ projectId: { $exists: false } }, { projectId: null }] }, { $set: { projectId } });
    }
  }
}

module.exports = { backfillProjects, patchProjectsById, getProjects, postProjects };
