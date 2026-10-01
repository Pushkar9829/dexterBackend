const { logRun } = require("../../adapters/common");
const { ID_DOC_RE, identityCheck } = require("../../adapters/idcheck");
const { canApproveApplication, isOfficeAdmin, companyScope } = require("../../middlewares/rbac");
const repo = require("./documents.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

async function postDocumentsByIdIdCheck(ctx) {
  if (!canApproveApplication(ctx.user) && !isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
  const doc = await repo.documents.findById(oid(ctx.params.id));
  if (!doc || !companyScope(ctx.user, doc.companyId)) return { status: 404, body: { error: "not found" } };
  if (!ID_DOC_RE.test(doc.type || "")) return { status: 400, body: { error: "ID check is for PAN, Aadhaar and driving licence documents" } };
  const result = await identityCheck(doc);
  await repo.documents.updateById(doc._id, { $set: { identityCheck: result } });
  if (result.provider !== "off") await logRun("idcheck", result.status !== "Failed", doc.type + ": " + result.status + (result.error ? " — " + result.error : ""));
  await writeAudit(ctx, "IdentityChecked", { companyId: doc.companyId, module: "CRM-02", recordId: doc._id, before: doc.identityCheck ? { identityCheck: doc.identityCheck } : null, after: { identityCheck: result } });
  return { status: 200, body: { identityCheck: result } };
}

module.exports = { postDocumentsByIdIdCheck };
