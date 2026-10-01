const { companyScope } = require("../../middlewares/rbac");
const repo = require("./auth.repository");
const { publicUser } = require("./auth.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

function publicUserFields(u) {
  return {
    id: String(u._id),
    login: u.login,
    name: u.name,
    hierarchy: u.hierarchy,
    functionalRole: u.functionalRole || "",
    companyId: u.companyId ? String(u.companyId) : null,
    homeCompanyId: u.homeCompanyId ? String(u.homeCompanyId) : u.companyId ? String(u.companyId) : null,
    franchiseId: u.franchiseId ? String(u.franchiseId) : null,
    projectIds: (u.projectIds || []).map(String),
    canSwitchCompany: u.hierarchy === "DexterIndiaCompanyTeam",
  };
}

async function postAuthCompany(ctx) {
  if (ctx.user.hierarchy !== "DexterIndiaCompanyTeam") return { status: 403, body: { error: "only Dexter India / Company Team switch companies" } };
  const target = oid(ctx.body.companyId);
  if (!target || !companyScope(ctx.user, target)) return { status: 403, body: { error: "company not granted" } };
  const company = await repo.companies.findOne({ _id: target, active: { $ne: false } });
  if (!company) return { status: 404, body: { error: "company not found or inactive" } };
  const from = ctx.user.companyId;
  await repo.sessions.updateById(ctx.sessionId, { $set: { activeCompanyId: target } });
  await repo.session_log.updateById(ctx.sessionId, { $set: { activeCompanyId: target } });
  ctx.user.homeCompanyId = ctx.user.homeCompanyId || from;
  ctx.user.companyId = target;
  await writeAudit(ctx, "CompanySwitched", { companyId: target, module: "CRM-01", before: { companyId: from }, after: { companyId: target }, work: company.name });
  return { status: 200, body: { user: publicUser ? publicUser(ctx.user) : publicUserFields(ctx.user), company: { _id: company._id, name: company.name, code: company.code } } };
}

module.exports = { publicUserFields, postAuthCompany };
