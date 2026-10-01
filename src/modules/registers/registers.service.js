const { companyScope, can, isFieldStaff, isOfficeAdmin } = require("../../middlewares/rbac");
const { checkExtra } = require("../legal/legal.service");
const { REGISTERS, COLUMN_TYPES, REGISTER_MODULE } = require("./registers.model");
const repo = require("./registers.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { readFileData } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, recordInProject, inFranchiseScope } = require("../../utils/scope");

async function getRegisterColumns(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  if (ctx.query.register) filter.register = String(ctx.query.register);
  return { status: 200, body: { registers: Object.keys(REGISTERS), types: COLUMN_TYPES, columns: await repo.register_columns.list(filter, { sort: { createdAt: 1 } }) } };
}

async function patchRegistersByRegisterByIdExtra(ctx) {
  const name = REGISTERS[ctx.params.register];
  if (!name) return { status: 400, body: { error: "register must be " + Object.keys(REGISTERS).join(", ") } };
  const module = REGISTER_MODULE[ctx.params.register] || "CRM-02";
  if (!can(ctx.user, "Edit", module)) return { status: 403, body: { error: "Edit not granted on " + module } };
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy) || isFieldStaff(ctx.user)) return { status: 403, body: { error: "extra columns are office-only" } };
  const row = await repo.collection(name).findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId) || !recordInProject(ctx.user, row)) return { status: 404, body: { error: "not found" } };
  const r = await checkExtra(row.companyId, ctx.params.register, ctx.body.extra, row.extra, { parentId: row._id, userId: ctx.user._id, franchiseId: row.franchiseId });
  if (r.error) return { status: 400, body: { error: r.error } };
  await repo.collection(name).updateById(row._id, { $set: { extra: r.extra, updatedAt: new Date() } });
  await writeAudit(ctx, "ExtraColumnsChanged", { companyId: row.companyId, module, recordId: row._id, before: row.extra || {}, after: r.extra, work: ctx.params.register });
  return { status: 200, body: { ok: true, extra: r.extra } };
}

async function getRegistersByRegisterByIdFileByDocId(ctx) {
  const name = REGISTERS[ctx.params.register];
  if (!name) return { status: 400, body: { error: "unknown register" } };
  const row = await repo.collection(name).findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId) || !recordInProject(ctx.user, row)) return { status: 404, body: { error: "not found" } };
  if (!can(ctx.user, "View", REGISTER_MODULE[ctx.params.register] || "CRM-02")) return { status: 403, body: { error: "View not granted" } };
  if (row.franchiseId && !(await inFranchiseScope(ctx.user, row.franchiseId))) return { status: 403, body: { error: "own records only" } };
  const doc = await repo.documents.findOne({ _id: oid(ctx.params.docId), parentType: "register:" + ctx.params.register, parentId: row._id });
  if (!doc) return { status: 404, body: { error: "file not found" } };
  const data = await readFileData(doc);
  return { status: 200, body: { fileName: doc.fileName, mime: doc.mime, data: data.toString("base64") } };
}

async function postRegisterColumns(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const name = String(ctx.body.name || "").trim();
  if (!name) return { status: 400, body: { error: "name required" } };
  if (name.includes(".") || name.startsWith("$") || name.length > 60) return { status: 400, body: { error: "column name cannot contain '.' or start with '$' (max 60)" } };
  const register = String(ctx.body.register || "agreement");
  if (!REGISTERS[register]) return { status: 400, body: { error: "register must be " + Object.keys(REGISTERS).join(", ") } };
  const type = String(ctx.body.type || "text");
  if (!COLUMN_TYPES.includes(type)) return { status: 400, body: { error: "type must be " + COLUMN_TYPES.join(", ") } };
  if (await repo.register_columns.findOne({ companyId, register, name })) return { status: 409, body: { error: "column " + name + " already exists on " + register } };
  const options = type === "status" ? [...new Set((Array.isArray(ctx.body.options) ? ctx.body.options : String(ctx.body.options || "").split(",")).map((s) => String(s).trim()).filter(Boolean))] : [];
  if (type === "status" && options.length < 2) return { status: 400, body: { error: "a status column needs at least 2 options" } };
  if (type === "file" && ctx.body.required) return { status: 400, body: { error: "a file column cannot be required (files attach after the record is saved)" } };
  const doc = {
    companyId,
    register,
    name,
    type,
    options,
    required: !!ctx.body.required,
    createdAt: new Date(),
  };
  const result = await repo.register_columns.insert(doc);
  await writeAudit(ctx, "ColumnAdded", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function deleteRegisterColumnsById(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const row = await repo.register_columns.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  await repo.register_columns.deleteById(row._id);
  const field = "extra." + row.name;
  const moved = REGISTERS[row.register]
    ? await repo.collection(REGISTERS[row.register]).updateMany({ companyId: row.companyId, [field]: { $exists: true } }, { $rename: { [field]: "removedExtra." + String(row._id) } })
    : { modifiedCount: 0 };
  await writeAudit(ctx, "ColumnRemoved", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before: row, work: moved.modifiedCount + " stored values moved to history" });
  return { status: 200, body: { ok: true } };
}

module.exports = { getRegisterColumns, patchRegistersByRegisterByIdExtra, getRegistersByRegisterByIdFileByDocId, postRegisterColumns, deleteRegisterColumnsById };
