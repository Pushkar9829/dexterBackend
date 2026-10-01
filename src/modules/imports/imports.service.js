const { ObjectId } = require("mongodb");
const { can, isOfficeAdmin, companyScope } = require("../../middlewares/rbac");
const { TEMPLATES, IMPORTERS } = require("./imports.registry");
const repo = require("./imports.repository");
const { TXN_TYPES } = require("../ops/ops.model");
const { canRunOps, newCtx, saveTxn, saveCbr1, saveCbr2, saveFunding } = require("../ops/ops.service");
const { writeAudit } = require("../../utils/audit-writer");
const { parseCsv, csvCell } = require("../../utils/csv");
const { normDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { readXlsx } = require("../../utils/xlsx");

async function getImportsTemplates(ctx) {
  return { status: 200, body: { templates: TEMPLATES } };
}

async function postImports(request) {
  const template = String(request.body.template || "");
  if (!TEMPLATES[template]) return { status: 400, body: { error: "unknown template" } };
  const extra = IMPORTERS[template];
  if (extra ? !extra.canImport(request.user) : !canRunOps(request.user)) {
    return { status: 403, body: { error: extra ? extra.denied : "Ops / Admin import company-wide files" } };
  }
  const importModule = (extra && extra.module) || "CRM-04";
  if (!can(request.user, "Create", importModule)) return { status: 403, body: { error: "Create action on " + importModule + " not granted" } };
  let rows;
  let original;
  if (request.body.xlsx) {
    const buf = Buffer.from(String(request.body.xlsx), "base64");
    if (buf.length > 10 * 1024 * 1024) return { status: 400, body: { error: "file larger than 10 MB" } };
    try {
      rows = readXlsx(buf).map((r) => r.map((c) => String(c == null ? "" : c)));
    } catch (err) {
      return { status: 400, body: { error: "could not read the Excel file: " + err.message } };
    }
    original = { kind: "xlsx", data: String(request.body.xlsx) };
  } else {
    rows = parseCsv(request.body.csv);
    original = { kind: "csv", data: String(request.body.csv || "") };
  }
  if (rows.length < 2) return { status: 400, body: { error: "file has no data rows" } };
  let header = rows[0].map((h) => String(h).trim());
  let gridDates = null;
  if (template === "TXN-grid") {
    gridDates = header.slice(2).map((h) => normDate(h));
    if (header[0] !== "atmId" || header[1] !== "metric") return { status: 400, body: { error: "grid layout: first columns must be atmId, metric; then one column per date" } };
    const bad = header.slice(2).filter((h, i) => !gridDates[i]);
    if (bad.length) return { status: 400, body: { error: "grid date columns must be dates (YYYY-MM-DD or DD.MM.YYYY): " + bad.join(", ") } };
    const long = [];
    for (const r of rows.slice(1)) {
      const metric = String(r[1] || "").trim();
      gridDates.forEach((d, i) => {
        const v = r[i + 2];
        if (v !== undefined && String(v).trim() !== "") long.push([r[0], d, metric, v]);
      });
    }
    header = ["atmId", "date", "metric", "value"];
    rows = [header, ...long];
  }
  const required = extra && extra.required ? extra.required : ["atmId", "date"];
  const missing = TEMPLATES[template].filter((h) => required.includes(h) && !header.includes(h));
  if (template === "CBR-1" && !header.includes("deno")) missing.push("deno");
  if (template === "TXN-daily-long" && !header.includes("type")) missing.push("type");
  if (missing.length) return { status: 400, body: { error: "missing columns: " + missing.join(", ") } };
  const unknown = template === "TXN-grid" ? [] : header.filter((h) => h && !TEMPLATES[template].includes(h));

  const ctx = newCtx(request);
  const batchId = new ObjectId();
  const errors = [];
  let accepted = 0;
  const inputs = rows.slice(1).map((row) => {
    const input = {};
    header.forEach((h, j) => (input[h] = row[j] === undefined ? "" : row[j]));
    if (template === "TXN-grid") {
      const m = String(input.metric || "").trim();
      return { atmId: input.atmId, date: input.date, [m]: input.value, _metric: m };
    }
    return input;
  });

  if (request.body.preview) {
    const target = { "TXN-daily": "ops_txn", "TXN-daily-long": "ops_txn", "TXN-grid": "ops_txn", "CBR-1": "ops_cbr1", "CBR-2": "ops_cbr2" }[template] || (template.startsWith("CBR-3") ? "ops_funding" : null);
    let replaces = null;
    if (target) {
      const keys = [...new Set(inputs.map((i) => String(i.atmId || "").trim() + "|" + (normDate(i.date) || "")).filter((k) => !k.endsWith("|")))];
      replaces = keys.length ? await repo.collection(target).count({ companyId: ctx.companyId, $or: keys.slice(0, 2000).map((k) => ({ atmId: k.split("|")[0], date: k.split("|")[1] })) }) : 0;
    }
    return { status: 200, body: { preview: { template, header, totalRows: rows.length - 1, sample: rows.slice(1, 21), ignoredColumns: unknown, replaces, rule: (extra && extra.rule) || "accept good rows, reject bad rows; same Company + ATM + date (+ deno / type) replaces the previous value" } } };
  }
  if (extra && extra.allOrNothing) {
    const seen = new Set();
    for (let i = 0; i < inputs.length; i++) {
      const r = await extra.validate(ctx, inputs[i], seen);
      if (r.errors) r.errors.forEach((e) => errors.push({ line: i + 2, column: e.column, reason: e.reason }));
      else inputs[i] = r.value;
    }
  }
  for (let i = 1; i < rows.length; i++) {
    if (extra && extra.allOrNothing && errors.length) break;
    const input = inputs[i - 1];
    let r;
    if (extra) r = await extra.save(ctx, input, batchId);
    else if (template === "TXN-grid") {
      const allowed = [...TXN_TYPES.flatMap((t) => [t + "Count", t + "Amount"]), "issuedIndent", "failedCount"];
      r = allowed.includes(input._metric) ? await saveTxn(ctx, input, "import", batchId) : { errors: [{ column: "metric", reason: "metric must be one of " + allowed.join(", ") }] };
    } else if (template.startsWith("TXN")) r = await saveTxn(ctx, input, "import", batchId);
    else if (template === "CBR-1") r = await saveCbr1(ctx, input, "import", batchId);
    else if (template === "CBR-2") r = await saveCbr2(ctx, input, "import", batchId);
    else r = await saveFunding(ctx, input, "import", batchId, template.slice(6));
    if (r.errors) r.errors.forEach((e) => errors.push({ line: i + 1, column: e.column, reason: e.reason }));
    else accepted++;
  }
  const rejectedLines = extra && extra.allOrNothing && errors.length ? rows.length - 1 - accepted : new Set(errors.map((e) => e.line)).size;
  const batch = {
    _id: batchId,
    companyId: ctx.companyId,
    template,
    fileName: String(request.body.fileName || template + (original.kind === "xlsx" ? ".xlsx" : ".csv")),
    file: original.kind === "csv" ? original.data : "",
    fileXlsx: original.kind === "xlsx" ? original.data : "",
    fileKind: original.kind,
    userId: request.user._id,
    login: request.user.login,
    ip: request.ip,
    at: new Date(),
    totalRows: rows.length - 1,
    accepted,
    rejected: rejectedLines,
    errors,
    ignoredColumns: unknown,
    rule: (extra && extra.rule) || "accept good rows, reject bad rows; same Company + ATM + date (+ deno / type) replaces the previous value",
  };
  await repo.import_batches.insert(batch);
  const event = extra ? extra.event : template.startsWith("TXN") ? "TXNImported" : template.startsWith("CBR-3") ? "FundingImported" : "CBRImported";
  await writeAudit(request, event, { module: extra ? extra.module : "CRM-04", recordId: batchId, work: template + ": " + accepted + " accepted, " + rejectedLines + " rejected" });
  const { file, fileXlsx, ...summary } = batch;
  return { status: 200, body: { batch: summary } };
}

async function getImports(ctx) {
  const filter = { companyId: oid(ctx.user.companyId) };
  if (!isOfficeAdmin(ctx.user)) filter.userId = ctx.user._id;
  const list = await repo.import_batches.list(filter, { projection: { file: 0, fileXlsx: 0, errors: 0 }, sort: { at: -1 }, limit: 100 });
  return { status: 200, body: { batches: list } };
}

async function getImportsByIdOriginal(ctx) {
  const b = await repo.import_batches.findById(oid(ctx.params.id));
  if (!b || !companyScope(ctx.user, b.companyId)) return { status: 404, body: { error: "not found" } };
  if (!isOfficeAdmin(ctx.user) && String(b.userId) !== String(ctx.user._id)) return { status: 403, body: { error: "importer or Admin only" } };
  await writeAudit(ctx, "ImportOriginalDownloaded", { companyId: b.companyId, module: "CRM-04", recordId: b._id, work: b.fileName });
  if (b.fileKind === "xlsx") return { status: 200, body: { fileName: b.fileName, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: b.fileXlsx } };
  return { status: 200, body: { fileName: b.fileName, mime: "text/csv", data: Buffer.from(b.file || "", "utf8").toString("base64") } };
}

async function getImportsByIdErrors(ctx) {
  const b = await repo.import_batches.findById(oid(ctx.params.id));
  if (!b || !companyScope(ctx.user, b.companyId)) return { status: 404, body: { error: "not found" } };
  if (!isOfficeAdmin(ctx.user) && String(b.userId) !== String(ctx.user._id)) return { status: 403, body: { error: "importer or Admin only" } };
  const lines = ["line,column,reason", ...b.errors.map((e) => [e.line, e.column, e.reason].map(csvCell).join(","))];
  return { status: 200, body: { fileName: b.template + "-errors.csv", csv: lines.join("\n") } };
}

module.exports = { getImportsTemplates, postImports, getImports, getImportsByIdOriginal, getImportsByIdErrors };
