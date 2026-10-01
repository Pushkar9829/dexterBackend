const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const repo = require("./affidavits.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { storeFile, readFileData } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { checkFile } = require("../../utils/upload");

async function getAffidavitFormats(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const list = await repo.affidavit_formats.list({ companyId }, { projection: { data: 0 }, sort: { model: 1, version: -1 } });
  const seen = new Set();
  list.forEach((f) => {
    f.version = f.version || 1;
    if (f.current === undefined) f.current = !seen.has(f.model);
    seen.add(f.model);
  });
  return { status: 200, body: { formats: list } };
}

async function postAffidavitFormats(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const model = String(ctx.body.model || "");
  if (!model || !ctx.body.data) return { status: 400, body: { error: "model and file required" } };
  const file = checkFile(ctx.body.fileName || "affidavit.pdf", ctx.body.data);
  if (file.error) return { status: 400, body: { error: file.error } };
  const last = await repo.affidavit_formats.find({ companyId, model }).sort({ version: -1 }).limit(1).next();
  const version = ((last && last.version) || (last ? 1 : 0)) + 1;
  const doc = {
    companyId,
    model,
    version,
    current: true,
    fileName: file.name,
    mime: file.mime,
    ...(await storeFile(file.data, file.name, file.mime)),
    createdBy: ctx.user._id,
    createdAt: new Date(),
  };
  await repo.affidavit_formats.updateMany({ companyId, model }, { $set: { current: false } });
  const result = await repo.affidavit_formats.insert(doc);
  await writeAudit(ctx, "AffidavitFormatPublished", { companyId, module: "CRM-02", recordId: result.insertedId, before: last ? { version: last.version || 1 } : null, after: { version, current: true }, work: model + " v" + version });
  return { status: 200, body: { id: String(result.insertedId), version } };
}

async function patchAffidavitFormatsByIdCurrent(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const row = await repo.affidavit_formats.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const prev = await repo.affidavit_formats.findOne({ companyId: row.companyId, model: row.model, current: true });
  await repo.affidavit_formats.updateMany({ companyId: row.companyId, model: row.model }, { $set: { current: false } });
  await repo.affidavit_formats.updateById(row._id, { $set: { current: true } });
  await writeAudit(ctx, "AffidavitFormatCurrent", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before: { current: prev ? "v" + (prev.version || 1) : null }, after: { current: "v" + (row.version || 1) }, work: row.model });
  return { status: 200, body: { ok: true } };
}

async function getAffidavitFormatsByIdFile(ctx) {
  const row = await repo.affidavit_formats.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: { fileName: row.fileName, mime: row.mime, version: row.version || 1, data: (await readFileData(row)).toString("base64") } };
}

module.exports = { getAffidavitFormats, postAffidavitFormats, patchAffidavitFormatsByIdCurrent, getAffidavitFormatsByIdFile };
