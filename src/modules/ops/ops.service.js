const { can, isOfficeAdmin, officeRole, isFieldStaff, companyScope, canApproveApplication } = require("../../middlewares/rbac");
const { AppError } = require("../../middlewares/errors");
const { registerImporter, TEMPLATES } = require("../imports/imports.registry");
const { DENOS, DEFAULT_TXN_ENTRY_DAYS, TXN_TYPE_NAMES, TXN_TYPES, CBR1_COLS, CBR1_SIDE_ROWS, CBR2_FIELDS, FUNDING_TYPES, WLA_FIELDS, AXIS_FIELDS, EOD_TIME } = require("./ops.model");
const repo = require("./ops.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { normDate, shiftDate, istToday } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, inFranchiseScope, atmInProject, applyFranchiseFilter } = require("../../utils/scope");

async function companyOps(ctx) {
  if (!ctx.opsSettings) {
    const lu = (await repo.lookups.findOne({ companyId: ctx.companyId })) || {};
    const denos = Array.isArray(lu.denos) && lu.denos.length ? lu.denos.map(Number).filter((d) => DENOS.includes(d)) : DENOS;
    ctx.opsSettings = { denos, txnEntryDays: Number(lu.txnEntryDays) > 0 ? Number(lu.txnEntryDays) : DEFAULT_TXN_ENTRY_DAYS };
  }
  return ctx.opsSettings;
}

function isAdmin(user) {
  return user.hierarchy === "Admin" || user.hierarchy === "DexterIndiaCompanyTeam";
}

function canRunOps(user) {
  if (!can(user, "Create", "CRM-04")) return false;
  return isOfficeAdmin(user) || officeRole(user, ["ServiceProjectOps", "Executive"]);
}

function canConfirmTxn(user) {
  if (FRANCHISE_LAYERS.includes(user.hierarchy) || isFieldStaff(user)) return false;
  if (user.functionalRole) return user.functionalRole === "Verifier";
  return isOfficeAdmin(user) || user.hierarchy === "Director";
}

function numField(v, name, errors) {
  if (v === undefined || v === null || String(v).trim() === "") return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) {
    errors.push({ column: name, reason: "not a number: " + v });
    return 0;
  }
  return n;
}

function blank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function newCtx(ctx) {
  return { ctx, user: ctx.user, companyId: oid(ctx.user.companyId), admin: isAdmin(ctx.user), atmCache: new Map() };
}

async function resolveAtm(ctx, atmId, date) {
  const id = String(atmId || "").trim();
  if (!id) return { error: { column: "atmId", reason: "ATM ID required" } };
  if (!ctx.atmCache.has(id)) ctx.atmCache.set(id, await repo.atms.findOne({ companyId: ctx.companyId, atmId: id }));
  const atm = ctx.atmCache.get(id);
  if (!atm) return { error: { column: "atmId", reason: "ATM ID " + id + " is not in this company" } };
  if (!atm.cashLiveDate) return { error: { column: "atmId", reason: "ATM " + id + " is not Cash Live" } };
  const live = new Date(atm.cashLiveDate).toISOString().slice(0, 10);
  if (date < live) return { error: { column: "date", reason: "before Cash Live date " + live } };
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy) && !(await inFranchiseScope(ctx.user, atm.franchiseId))) {
    return { error: { column: "atmId", reason: "own ATMs only" } };
  }
  if (!atmInProject(ctx.user, atm)) return { error: { column: "atmId", reason: "ATM " + id + " is outside your projects" } };
  return { atm };
}

async function dayLocked(ctx, atmId, date) {
  if (ctx.admin) return false;
  return !!(await repo.ops_eod.findOne({ companyId: ctx.companyId, atmId, date, status: "Verified" }));
}

function rowStamp(ctx, atm, source, batchId) {
  return {
    atmRef: atm._id,
    franchiseId: atm.franchiseId || null,
    siteId: atm.siteId || "",
    model: atm.model || "",
    source,
    importBatchId: batchId || null,
    updatedBy: ctx.user._id,
    updatedAt: new Date(),
  };
}

async function guardRow(ctx, input) {
  const errors = [];
  const date = normDate(input.date);
  if (!date) errors.push({ column: "date", reason: "date must be YYYY-MM-DD or DD.MM.YYYY" });
  if (errors.length) return { errors };
  const r = await resolveAtm(ctx, input.atmId, date);
  if (r.error) return { errors: [r.error] };
  if (await dayLocked(ctx, r.atm.atmId, date)) return { errors: [{ column: "date", reason: "EOD verified for this ATM-day; Admin correction only" }] };
  return { date, atm: r.atm };
}

async function snapshot(name, where, set) {
  const row = await repo.collection(name).findOne(where);
  if (!row) return null;
  const out = {};
  for (const k of Object.keys(set)) {
    const v = k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), row);
    out[k] = v === undefined ? null : v;
  }
  return out;
}

async function saveTxn(ctx, input, source, batchId) {
  const g = await guardRow(ctx, input);
  if (g.errors) return g;
  const errors = [];
  const set = {};
  if (!blank(input.type)) {
    const key = TXN_TYPE_NAMES[String(input.type).trim().toLowerCase()];
    if (!key) return { errors: [{ column: "type", reason: "type must be Non-Cash, Cash, UPI or Deposit" }] };
    set[key + "Count"] = numField(input.count, "count", errors);
    set[key + "Amount"] = numField(input.amount, "amount", errors);
  } else {
    TXN_TYPES.forEach((t) => {
      if (!blank(input[t + "Count"])) set[t + "Count"] = numField(input[t + "Count"], t + "Count", errors);
      if (!blank(input[t + "Amount"])) set[t + "Amount"] = numField(input[t + "Amount"], t + "Amount", errors);
    });
    if (!blank(input.failedCount)) set.failedCount = numField(input.failedCount, "failedCount", errors);
    if (!Object.keys(set).length && blank(input.issuedIndent)) return { errors: [{ column: "count", reason: "enter at least one count or amount" }] };
  }
  if (!blank(input.issuedIndent)) set.issuedIndent = numField(input.issuedIndent, "issuedIndent", errors);
  if (errors.length) return { errors };
  if (!ctx.admin) {
    const { txnEntryDays } = await companyOps(ctx);
    if (g.date < shiftDate(istToday(), -txnEntryDays)) return { errors: [{ column: "date", reason: "older than the " + txnEntryDays + "-day TXN entry window; Admin correction only" }] };
    const prev = await repo.ops_txn.findOne({ companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date }, { projection: { confirmedAt: 1 } });
    if (prev && prev.confirmedAt) return { errors: [{ column: "date", reason: "TXN confirmed by the Verifier; Admin correction only" }] };
  }
  const locked = await executiveLocked(ctx, "ops_txn", { atmId: g.atm.atmId, date: g.date });
  if (locked) return locked;
  const init = {};
  TXN_TYPES.forEach((t) => {
    if (set[t + "Count"] === undefined) init[t + "Count"] = 0;
    if (set[t + "Amount"] === undefined) init[t + "Amount"] = 0;
  });
  const where = { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date };
  const before = await snapshot("ops_txn", where, set);
  await repo.ops_txn.updateOne(where, { $set: { ...set, ...rowStamp(ctx, g.atm, source, batchId) }, $setOnInsert: { ...init, createdAt: new Date() } }, { upsert: true });
  return { ok: true, key: g.atm.atmId + " " + g.date, before, set };
}

function denoLine(deno, src, errors, label) {
  const out = {};
  CBR1_COLS.forEach((c) => {
    const nRaw = src[c + "Notes"];
    const aRaw = src[c + "Amount"];
    let notes = blank(nRaw) ? null : numField(nRaw, label + c + "Notes", errors);
    let amount = blank(aRaw) ? null : numField(aRaw, label + c + "Amount", errors);
    if (notes !== null && amount !== null && notes * deno !== amount) {
      errors.push({ column: label + c, reason: notes + " notes × " + deno + " ≠ " + amount });
    }
    if (notes !== null && amount === null) amount = notes * deno;
    if (amount !== null && notes === null) {
      if (amount % deno) errors.push({ column: label + c + "Amount", reason: amount + " is not a multiple of " + deno });
      notes = amount / deno;
    }
    out[c + "Notes"] = notes || 0;
    out[c + "Amount"] = amount || 0;
  });
  return out;
}

function sideLine(src, errors, label) {
  const out = {};
  CBR1_COLS.forEach((c) => (out[c + "Amount"] = blank(src[c + "Amount"]) ? 0 : numField(src[c + "Amount"], label + c + "Amount", errors)));
  return out;
}

async function saveCbr1(ctx, input, source, batchId) {
  const g = await guardRow(ctx, input);
  if (g.errors) return g;
  const errors = [];
  const set = {};
  const side = String(input.deno || "").trim().toUpperCase();
  if (CBR1_SIDE_ROWS.includes(side)) {
    set["side." + side] = sideLine(input, errors, "");
  } else if (!blank(input.deno)) {
    const deno = Number(input.deno);
    const { denos } = await companyOps(ctx);
    if (!denos.includes(deno)) return { errors: [{ column: "deno", reason: "deno must be one of " + denos.join("/") + " or AQS / WLACBR" }] };
    set["denos." + deno] = denoLine(deno, input, errors, "");
  } else if (source === "import") {
    return { errors: [{ column: "deno", reason: "deno required" }] };
  } else {
    DENOS.forEach((d) => {
      if (input.denos && input.denos[d]) set["denos." + d] = denoLine(d, input.denos[d], errors, d + " ");
    });
    CBR1_SIDE_ROWS.forEach((s) => {
      if (input.side && input.side[s]) set["side." + s] = sideLine(input.side[s], errors, s + " ");
    });
  }
  ["indent", "eodTime", "remarks", "cra", "fr", "location", "bank"].forEach((k) => !blank(input[k]) && (set[k] = String(input[k]).trim()));
  if (!blank(input.switchCounter)) set.switchCounter = numField(input.switchCounter, "switchCounter", errors);
  if (errors.length) return { errors };
  const locked = await executiveLocked(ctx, "ops_cbr1", { atmId: g.atm.atmId, date: g.date });
  if (locked) return locked;
  const where = { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date };
  const before = await snapshot("ops_cbr1", where, set);
  await repo.ops_cbr1.updateOne(where, { $set: { ...set, ...rowStamp(ctx, g.atm, source, batchId) }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return { ok: true, key: g.atm.atmId + " " + g.date, before, set };
}

function cbr1Totals(doc) {
  const totals = {};
  CBR1_COLS.forEach((c) => {
    totals[c] = DENOS.reduce((s, d) => s + (((doc.denos || {})[d] || {})[c + "Amount"] || 0), 0);
  });
  const wla = (doc.side || {}).WLACBR;
  if (wla) {
    totals.wlacbrDiff = {};
    CBR1_COLS.forEach((c) => (totals.wlacbrDiff[c] = totals[c] - (wla[c + "Amount"] || 0)));
  }
  return totals;
}

async function saveCbr2(ctx, input, source, batchId) {
  const g = await guardRow(ctx, input);
  if (g.errors) return g;
  const errors = [];
  const set = {};
  CBR2_FIELDS.forEach((f) => (set[f] = numField(input[f], f, errors)));
  ["mfName", "indentNo", "eodTime", "remarks"].forEach((k) => (set[k] = String(input[k] || "").trim()));
  if (errors.length) return { errors };
  const locked = await executiveLocked(ctx, "ops_cbr2", { atmId: g.atm.atmId, date: g.date });
  if (locked) return locked;
  const where = { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date };
  const before = await snapshot("ops_cbr2", where, set);
  await repo.ops_cbr2.updateOne(where, { $set: { ...set, ...rowStamp(ctx, g.atm, source, batchId) }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return { ok: true, key: g.atm.atmId + " " + g.date, before, set };
}

function fundingCalc(type, v) {
  if (type === "WLA") {
    const closingWla = v.openingWla + v.fundHpy - v.withdrawal;
    const loadingDiff = v.loadingCbr - v.withdrawal;
    return { closingWla, loadingDiff, calcMismatch: loadingDiff !== 0 || closingWla < 0 };
  }
  const indentTotal = v.axisLot1 + v.axisLot2;
  const loadingDiff = v.loadingCbr - indentTotal;
  const dispenseCover = indentTotal - (v.lastDayDispenseApna || 0);
  return { indentTotal, loadingDiff, dispenseCover, calcMismatch: loadingDiff !== 0 };
}

async function executiveLocked(ctx, collection, key) {
  if (ctx.user.functionalRole !== "Executive") return null;
  const row = await repo.collection(collection).findOne({ companyId: ctx.companyId, ...key });
  if (!row || !row.updatedBy || String(row.updatedBy) === String(ctx.user._id)) return null;
  const by = await repo.users.findById(row.updatedBy, { functionalRole: 1, name: 1 });
  if (by && by.functionalRole === "Executive") return { errors: [{ column: "atmId", reason: "entered by " + (by.name || "another Executive") + "; Verifier / Admin can change it" }] };
  return null;
}

async function saveFunding(ctx, input, source, batchId, type) {
  if (!FUNDING_TYPES.includes(type)) return { errors: [{ column: "type", reason: "type must be " + FUNDING_TYPES.join(", ") }] };
  const g = await guardRow(ctx, input);
  if (g.errors) return g;
  const errors = [];
  const v = {};
  (type === "WLA" ? WLA_FIELDS : AXIS_FIELDS).forEach((f) => (v[f] = numField(input[f], f, errors)));
  if (errors.length) return { errors };
  const existing = await repo.ops_funding.findOne({ companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date, type });
  if (existing && existing.adminCorrected && !ctx.admin) return { errors: [{ column: "date", reason: "Admin corrected this row; Admin only" }] };
  const locked = await executiveLocked(ctx, "ops_funding", { atmId: g.atm.atmId, date: g.date, type });
  if (locked) return locked;
  await repo.ops_funding.updateOne(
    { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date, type },
    { $set: { ...v, ...fundingCalc(type, v), ...rowStamp(ctx, g.atm, source, batchId) }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  // later daily-loading rows take their last-day fund from the WLA closing
  if (type === "WLA") await require("../reports/reports.service").carryLoadingForward(ctx.companyId, g.atm.atmId, g.date);
  const before = existing ? Object.fromEntries(Object.keys(v).map((k) => [k, existing[k] === undefined ? null : existing[k]])) : null;
  return { ok: true, key: g.atm.atmId + " " + g.date + " " + type, before, set: v };
}

function eodCalc(e) {
  const sum = (m) => DENOS.reduce((s, d) => s + (Number((m || {})[d]) || 0) * d, 0);
  const purgeTotal = sum(e.purgeNotes);
  const physicalTotal = sum(e.physicalNotes);
  const loadingTotal = sum(e.loadingNotes);
  const expected = e.opening - e.dispenseMachine - purgeTotal;
  const dispenseDiff = e.dispenseMachine - e.dispenseApna;
  return {
    purgeTotal,
    physicalTotal,
    loadingTotal,
    expected,
    overage: Math.max(physicalTotal - expected, 0),
    shortage: Math.max(expected - physicalTotal, 0),
    closing: physicalTotal + loadingTotal,
    dispenseDiff,
    dispenseFlag: dispenseDiff !== 0,
  };
}

function eodInput(body, errors) {
  const notes = (m, label) => {
    const out = {};
    DENOS.forEach((d) => {
      const n = numField((m || {})[d], label + " " + d, errors);
      if (n < 0 || !Number.isInteger(n)) errors.push({ column: label + " " + d, reason: "note count must be a whole number, 0 or more" });
      out[d] = n;
    });
    return out;
  };
  const amount = (v, name) => {
    const n = numField(v, name, errors);
    if (n < 0) errors.push({ column: name, reason: "cannot be negative" });
    return n;
  };
  const eodTime = String(body.eodTime || EOD_TIME).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(eodTime)) errors.push({ column: "eodTime", reason: "EOD time must be HH:MM (24-hour)" });
  return {
    eodTime,
    eodTimeOff: eodTime !== EOD_TIME,
    dispenseMachine: amount(body.dispenseMachine, "dispenseMachine"),
    dispenseApna: amount(body.dispenseApna, "dispenseApna"),
    purgeNotes: notes(body.purgeNotes, "purge"),
    physicalNotes: notes(body.physicalNotes, "physical"),
    loadingNotes: notes(body.loadingNotes, "loading"),
    remarks: String(body.remarks || ""),
  };
}

function flatNotes(input, prefix) {
  if (input[prefix + "Notes"] && typeof input[prefix + "Notes"] === "object") return input[prefix + "Notes"];
  const out = {};
  DENOS.forEach((d) => input[prefix + d] !== undefined && (out[d] = input[prefix + d]));
  return out;
}

async function saveEod(ctx, body, source, batchId) {
  const g = await guardRow(ctx, body);
  if (g.errors) return g;
  const existing = await repo.ops_eod.findOne({ companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date });
  if (existing && existing.status !== "Draft") return { locked: true, errors: [{ column: "date", reason: "EOD already " + existing.status + "; Admin correction only" }] };
  const errors = [];
  const input = eodInput({ ...body, purgeNotes: flatNotes(body, "purge"), physicalNotes: flatNotes(body, "physical"), loadingNotes: flatNotes(body, "loading") }, errors);
  const prev = await previousClosing(ctx.companyId, g.atm.atmId, g.date);
  input.opening = prev !== null ? prev : numField(body.opening, "opening", errors);
  input.openingFromPreviousDay = prev !== null;
  if (errors.length) return { errors };
  const calc = eodCalc(input);
  const set = { ...input, ...calc, status: "Draft", openingMismatch: false, ...rowStamp(ctx, g.atm, source, batchId) };
  try {
    // only a Draft may be overwritten; if it was submitted meanwhile the upsert hits the unique index instead
    await repo.ops_eod.updateOne(
      { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date, ...(existing ? { status: "Draft" } : {}) },
      { $set: set, $setOnInsert: { createdAt: new Date(), createdBy: ctx.user._id } },
      { upsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) return { locked: true, errors: [{ column: "date", reason: "EOD was submitted meanwhile; reload" }] };
    throw err;
  }
  await carryClosingForward(ctx.companyId, g.atm.atmId, g.date, set.closing);
  const before = existing ? Object.fromEntries(Object.keys(input).map((k) => [k, existing[k] === undefined ? null : existing[k]])) : null;
  return { ok: true, key: g.atm.atmId + " " + g.date, set, calc, before };
}

registerImporter("EOD", {
  headers: ["atmId", "date", "eodTime", "opening", "dispenseMachine", "dispenseApna", ...["purge", "physical", "loading"].flatMap((p) => DENOS.map((d) => p + d)), "remarks"],
  canImport: (u) => canRunOps(u),
  denied: "Ops / Admin import EOD files",
  save: (ctx, input, batchId) => saveEod(ctx, input, "import", batchId),
  event: "EODImported",
  module: "CRM-04",
  rule: "accept good rows, reject bad rows; a Draft EOD for the same ATM-day is replaced; Submitted / Verified days are refused (Admin correction only)",
});

async function previousClosing(companyId, atmId, date) {
  const prev = await repo.ops_eod.findOne({ companyId, atmId, date: shiftDate(date, -1) });
  return prev ? prev.closing : null;
}

async function carryClosingForward(companyId, atmId, date, closing) {
  const next = await repo.ops_eod.findOne({ companyId, atmId, date: shiftDate(date, 1) });
  if (!next || next.opening === closing) {
    if (next && next.openingMismatch) await repo.ops_eod.updateById(next._id, { $set: { openingMismatch: false } });
    return;
  }
  if (next.status === "Draft") {
    const input = { ...next, opening: closing };
    await repo.ops_eod.updateById(next._id, { $set: { opening: closing, openingFromPreviousDay: true, openingMismatch: false, ...eodCalc(input) } });
  } else {
    await repo.ops_eod.updateById(next._id, { $set: { openingMismatch: true } });
  }
}

async function scopedList(ctx, name, extra) {
  const filter = { companyId: oid(ctx.user.companyId), ...extra };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  return repo.collection(name).list(filter, { sort: { date: -1, atmId: 1 }, limit: 2000 });
}

async function getOpsMeta(ctx) {
  const s = await companyOps(newCtx(ctx));
  return { status: 200, body: { denos: s.denos, allDenos: DENOS, txnEntryDays: s.txnEntryDays, canConfirm: canConfirmTxn(ctx.user), canExport: can(ctx.user, "Export", "CRM-04") && !isFieldStaff(ctx.user) && !FRANCHISE_LAYERS.includes(ctx.user.hierarchy), cbr1Cols: CBR1_COLS, cbr1SideRows: CBR1_SIDE_ROWS, txnTypes: TXN_TYPES, cbr2Fields: CBR2_FIELDS, wlaFields: WLA_FIELDS, axisFields: AXIS_FIELDS, templates: TEMPLATES } };
}

async function getOpsLiveAtms(ctx) {
  const filter = { companyId: oid(ctx.user.companyId), cashLiveDate: { $ne: null } };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  const atms = await repo.atms.list(filter, { projection: { atmId: 1, model: 1, city: 1, franchiseeName: 1, cashLiveDate: 1 }, sort: { atmId: 1 } });
  return { status: 200, body: { atms } };
}

async function writeRoute(ctx, fn, event, module) {
  if (!canRunOps(ctx.user)) return { status: 403, body: { error: "Ops / Admin only" } };
  const r = await fn(newCtx(ctx));
  if (r.errors) return { status: 400, body: { error: r.errors.map((e) => e.column + ": " + e.reason).join("; ") } };
  const flat = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/\./g, "/"), v])) : null);
  await writeAudit(ctx, event, { module: module || "CRM-04", work: r.key, before: flat(r.before), after: flat(r.set) || ctx.body });
  return { status: 200, body: { ok: true } };
}

async function getOpsTxn(ctx) {
  const month = /^\d{4}-\d{2}$/.test(String(ctx.query.month)) ? String(ctx.query.month) : istToday().slice(0, 7);
  const rows = await scopedList(ctx, "ops_txn", { date: { $regex: "^" + month } });
  const atmFilter = { companyId: oid(ctx.user.companyId), cashLiveDate: { $ne: null } };
  await applyFranchiseFilter(ctx.user, atmFilter, "franchiseId");
  const atms = await repo.atms.list(atmFilter);
  const today = istToday();
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const end = lastDay < today ? lastDay : today;
  const byKey = new Map(rows.map((r) => [r.atmId + " " + r.date, r]));
  const summary = atms.map((atm) => {
    const live = new Date(atm.cashLiveDate).toISOString().slice(0, 10);
    const totals = {};
    TXN_TYPES.forEach((t) => {
      totals[t + "Count"] = 0;
      totals[t + "Amount"] = 0;
    });
    let zeroDays = 0;
    let nonTxnDays = 0;
    let run = 0;
    let maxRun = 0;
    for (let d = month + "-01"; d <= end; d = shiftDate(d, 1)) {
      if (d < live) continue;
      const r = byKey.get(atm.atmId + " " + d);
      const count = r ? TXN_TYPES.reduce((s, t) => s + (r[t + "Count"] || 0), 0) : 0;
      if (r) TXN_TYPES.forEach((t) => ((totals[t + "Count"] += r[t + "Count"] || 0), (totals[t + "Amount"] += r[t + "Amount"] || 0)));
      if (!r) nonTxnDays++;
      else if (!count) zeroDays++;
      run = count ? 0 : run + 1;
      maxRun = Math.max(maxRun, run);
    }
    return { atmId: atm.atmId, totals, zeroDays, nonTxnDays, consecutiveZero: maxRun, currentZeroRun: run };
  });
  const withFlags = (await markLocked(oid(ctx.user.companyId), rows)).map((r) => ({ ...r, zeroTxn: !TXN_TYPES.some((t) => r[t + "Count"]) }));
  return { status: 200, body: { month, rows: withFlags, summary } };
}

async function putOpsTxn(request) {
  return writeRoute(request, (ctx) => saveTxn(ctx, request.body, "screen"), "TXNSaved");
}

async function postOpsTxnConfirm(ctx) {
  if (!canConfirmTxn(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const date = normDate(ctx.body.date);
  if (!date) return { status: 400, body: { error: "date required" } };
  const filter = { companyId, date, confirmedAt: null };
  if (ctx.body.atmId) filter.atmId = String(ctx.body.atmId).trim();
  const rows = await repo.ops_txn.list(filter, { projection: { atmId: 1, updatedBy: 1, atmRef: 1 } });
  const mine = rows.filter((r) => String(r.updatedBy) === String(ctx.user._id));
  if (mine.length && !isAdmin(ctx.user)) return { status: 403, body: { error: "you entered " + mine.map((r) => r.atmId).join(", ") + "; another Verifier confirms" } };
  const allowed = [];
  for (const r of rows) {
    const atm = await repo.atms.findById(r.atmRef);
    if (!atm || atmInProject(ctx.user, atm)) allowed.push(r._id);
  }
  if (!allowed.length) return { status: 400, body: { error: "nothing to confirm for " + date } };
  await repo.ops_txn.updateMany({ _id: { $in: allowed } }, { $set: { confirmedBy: ctx.user._id, confirmedAt: new Date() } });
  await writeAudit(ctx, "TXNConfirmed", { companyId, module: "CRM-04", work: date + " " + allowed.length + " ATM(s)" + (ctx.body.atmId ? " " + ctx.body.atmId : "") });
  return { status: 200, body: { ok: true, confirmed: allowed.length } };
}

async function getOpsTxnExport(ctx) {
  if (!can(ctx.user, "Export", "CRM-04") || isFieldStaff(ctx.user) || FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return { status: 403, body: { error: "Export not granted" } };
  const month = /^\d{4}-\d{2}$/.test(String(ctx.query.month)) ? String(ctx.query.month) : istToday().slice(0, 7);
  const rows = await scopedList(ctx, "ops_txn", { date: { $regex: "^" + month } });
  const head = ["atmId", "date", ...TXN_TYPES.flatMap((t) => [t + "Count", t + "Amount"]), "issuedIndent", "source", "confirmed"];
  const lines = rows.map((r) => [r.atmId, r.date, ...TXN_TYPES.flatMap((t) => [r[t + "Count"] || 0, r[t + "Amount"] || 0]), r.issuedIndent || "", r.source || "", r.confirmedAt ? "Yes" : "No"]);
  await writeAudit(ctx, "ReportExported", { module: "CRM-04", work: "TXN " + month + " " + rows.length + " rows" });
  return { status: 200, body: { fileName: "txn-" + month + ".csv", csv: "\uFEFF" + [head, ...lines].map((r) => r.map(csvCell).join(",")).join("\n") } };
}

async function markLocked(companyId, rows) {
  if (!rows.length) return rows;
  const verified = await repo.ops_eod.list({ companyId, status: "Verified", date: { $in: [...new Set(rows.map((r) => r.date))] } }, { projection: { atmId: 1, date: 1 } });
  const keys = new Set(verified.map((e) => e.atmId + " " + e.date));
  return rows.map((r) => ({ ...r, locked: keys.has(r.atmId + " " + r.date) }));
}

async function getOpsDay(ctx) {
  const companyId = oid(ctx.user.companyId);
  const date = normDate(ctx.query.date) || istToday();
  const atmFilter = { companyId, cashLiveDate: { $ne: null, $lte: new Date(date + "T23:59:59Z") } };
  await applyFranchiseFilter(ctx.user, atmFilter, "franchiseId");
  const atms = (await repo.atms.list(atmFilter, { projection: { atmId: 1, city: 1, franchiseeName: 1, cashLiveDate: 1, projectId: 1 }, sort: { atmId: 1 } })).filter((a) => atmInProject(ctx.user, a));
  const ids = atms.map((a) => a.atmId);
  const q = { companyId, date, atmId: { $in: ids } };
  const [txn, cbr1, cbr2, funding, eod, deposits] = await Promise.all([
    repo.ops_txn.list(q),
    repo.ops_cbr1.list(q, { projection: { atmId: 1 } }),
    repo.ops_cbr2.list(q, { projection: { atmId: 1 } }),
    repo.ops_funding.list(q, { projection: { atmId: 1, type: 1 } }),
    repo.ops_eod.list(q),
    repo.overage_deposits.list({ companyId, atmId: { $in: ids }, date: { $gte: date } }, { projection: { atmId: 1, amount: 1 } }),
  ]);
  const by = (list) => new Map(list.map((r) => [r.atmId, r]));
  const txnBy = by(txn);
  const eodBy = by(eod);
  const cbr1Set = new Set(cbr1.map((r) => r.atmId));
  const cbr2Set = new Set(cbr2.map((r) => r.atmId));
  const rows = atms.map((a) => {
    const t = txnBy.get(a.atmId);
    const e = eodBy.get(a.atmId);
    const deposited = deposits.filter((d) => d.atmId === a.atmId).reduce((s, d) => s + (d.amount || 0), 0);
    return {
      atmId: a.atmId,
      city: a.city || "",
      franchiseeName: a.franchiseeName || "",
      txn: t ? { confirmed: !!t.confirmedAt, zero: !TXN_TYPES.some((k) => t[k + "Count"]) } : null,
      cbr1: cbr1Set.has(a.atmId),
      cbr2: cbr2Set.has(a.atmId),
      funding: funding.filter((f) => f.atmId === a.atmId).map((f) => f.type),
      eod: e
        ? { _id: e._id, status: e.status, overage: e.overage || 0, shortage: e.shortage || 0, dispenseFlag: !!e.dispenseFlag, openingMismatch: !!e.openingMismatch, submittedBy: e.submittedBy || null, returnReason: e.status === "Draft" ? e.returnReason || "" : "" }
        : null,
      overageDeposited: deposited,
    };
  });
  return { status: 200, body: { date, rows, me: String(ctx.user._id) } };
}

async function getOpsPrefill(ctx) {
  const c = newCtx(ctx);
  const date = normDate(ctx.query.date) || istToday();
  const r = await resolveAtm(c, ctx.query.atmId, date);
  if (r.error) return { status: 400, body: { error: r.error.reason } };
  const atm = r.atm;
  const [prevEod, prevWla, prevCbr1] = await Promise.all([
    repo.ops_eod.findOne({ companyId: c.companyId, atmId: atm.atmId, date: shiftDate(date, -1) }, { projection: { closing: 1 } }),
    repo.ops_funding.findOne({ companyId: c.companyId, atmId: atm.atmId, type: "WLA", date: { $lt: date } }, { sort: { date: -1 }, projection: { closingWla: 1, date: 1 } }),
    repo.ops_cbr1.findOne({ companyId: c.companyId, atmId: atm.atmId, date: { $lt: date } }, { sort: { date: -1 }, projection: { cra: 1, bank: 1 } }),
  ]);
  return {
    status: 200,
    body: {
      atmId: atm.atmId,
      previousClosing: prevEod ? prevEod.closing : null,
      previousWlaClosing: prevWla ? prevWla.closingWla : null,
      previousWlaDate: prevWla ? prevWla.date : null,
      fr: atm.franchiseeName || "",
      location: [atm.city, atm.siteId].filter(Boolean).join(" · "),
      bank: atm.bankName || (prevCbr1 && prevCbr1.bank) || "",
      cra: (prevCbr1 && prevCbr1.cra) || "",
      fundingPath: atm.fundingPath || "",
    },
  };
}

async function getOpsCbr1(ctx) {
  const date = normDate(ctx.query.date);
  const rows = await markLocked(oid(ctx.user.companyId), await scopedList(ctx, "ops_cbr1", date ? { date } : {}));
  return { status: 200, body: { rows: rows.map((r, i) => ({ ...r, srNo: i + 1, totals: cbr1Totals(r) })) } };
}

async function putOpsCbr1(request) {
  return writeRoute(request, (ctx) => saveCbr1(ctx, request.body, "screen"), "CBRSaved");
}

async function getOpsCbr2(ctx) {
  const date = normDate(ctx.query.date);
  return { status: 200, body: { rows: await markLocked(oid(ctx.user.companyId), await scopedList(ctx, "ops_cbr2", date ? { date } : {})) } };
}

async function putOpsCbr2(request) {
  return writeRoute(request, (ctx) => saveCbr2(ctx, request.body, "screen"), "CBRSaved");
}

async function getOpsFunding(ctx) {
  const date = normDate(ctx.query.date);
  const rows = await markLocked(oid(ctx.user.companyId), await scopedList(ctx, "ops_funding", date ? { date } : {}));
  const admin = isAdmin(ctx.user);
  return { status: 200, body: { rows: admin ? rows : rows.map(({ calcMismatch, adminCorrected, ...rest }) => rest), adminView: admin } };
}

async function putOpsFunding(request) {
  return writeRoute(request, (ctx) => saveFunding(ctx, request.body, "screen", null, request.body.type), "FundingSaved");
}

async function patchOpsFundingByIdCorrect(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "wrong WLA / indent calculation is Admin only" } };
  const row = await repo.ops_funding.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const reason = String(ctx.body.reason || "").trim();
  if (!reason) return { status: 400, body: { error: "reason required" } };
  const errors = [];
  const v = {};
  (row.type === "WLA" ? WLA_FIELDS : AXIS_FIELDS).forEach((f) => (v[f] = ctx.body[f] === undefined ? row[f] : numField(ctx.body[f], f, errors)));
  if (errors.length) return { status: 400, body: { error: errors.map((e) => e.column + ": " + e.reason).join("; ") } };
  const set = { ...v, ...fundingCalc(row.type, v), adminCorrected: { by: ctx.user._id, at: new Date(), reason }, updatedAt: new Date() };
  await repo.ops_funding.updateById(row._id, { $set: set });
  if (row.type === "WLA") await require("../reports/reports.service").carryLoadingForward(row.companyId, row.atmId, row.date);
  const before = {};
  Object.keys(v).forEach((k) => (before[k] = row[k]));
  await writeAudit(ctx, "FundingAdminCorrected", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before, after: set, work: reason });
  return { status: 200, body: { ok: true } };
}

async function getOpsEod(ctx) {
  const date = normDate(ctx.query.date);
  return { status: 200, body: { rows: await scopedList(ctx, "ops_eod", date ? { date } : {}) } };
}

async function putOpsEod(ctx) {
  if (!canRunOps(ctx.user)) return { status: 403, body: { error: "Ops / Admin only" } };
  const r = await saveEod(newCtx(ctx), ctx.body, "screen", null);
  if (r.errors) return { status: r.locked ? 403 : 400, body: { error: r.errors.map((e) => e.column + ": " + e.reason).join("; ") } };
  await writeAudit(ctx, "EODSaved", { module: "CRM-04", work: r.key, before: r.before || null, after: r.set });
  return { status: 200, body: { ok: true, ...r.calc, opening: r.set.opening, eodTimeOff: r.set.eodTimeOff } };
}

async function loadEod(ctx) {
  const row = await repo.ops_eod.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) {
    throw new AppError(404, "not found");
  }
  return row;
}

async function postOpsEodByIdSubmit(ctx) {
  if (!canRunOps(ctx.user)) return { status: 403, body: { error: "Ops / Admin only" } };
  const row = await loadEod(ctx);
  if (row.status !== "Draft") return { status: 400, body: { error: "only a Draft EOD can be submitted" } };
  const moved = await repo.ops_eod.updateOne({ _id: row._id, status: "Draft" }, { $set: { status: "Submitted", submittedBy: ctx.user._id, submittedAt: new Date() } });
  if (!moved.matchedCount) return { status: 409, body: { error: "EOD changed meanwhile; reload" } };
  await writeAudit(ctx, "EODSubmitted", { companyId: row.companyId, module: "CRM-04", recordId: row._id, work: row.atmId + " " + row.date });
  const checkers = (await repo.users.list({ companyId: row.companyId, active: true }, { projection: { hierarchy: 1, functionalRole: 1, modules: 1, actions: 1 } })).filter((u) => canApproveApplication(u) && String(u._id) !== String(ctx.user._id));
  await require("../notices/notices.service")
    .notify(row.companyId, checkers.map((u) => u._id), { kind: "eod", title: "EOD to verify: " + row.atmId + " " + row.date, body: "Submitted by " + (ctx.user.name || ctx.user.login), link: { page: "ops", id: String(row._id), type: "EOD", date: row.date }, key: "eod-submitted:" + row._id + ":" + Date.now() })
    .catch(() => {});
  return { status: 200, body: { ok: true } };
}

async function verifyEodRow(ctx, row) {
  if (row.status !== "Submitted") return { status: 400, error: "only a Submitted EOD can be verified" };
  if (String(row.submittedBy) === String(ctx.user._id) && !isAdmin(ctx.user)) return { status: 403, error: "the submitter cannot verify the same EOD" };
  if (row.openingMismatch) return { status: 400, error: "opening does not match the previous day's closing; re-save or Admin-correct first" };
  const done = await repo.ops_eod.updateOne({ _id: row._id, status: "Submitted" }, { $set: { status: "Verified", verifiedBy: ctx.user._id, verifiedAt: new Date(), lockedAt: new Date() } });
  if (!done.matchedCount) return { status: 409, error: "EOD changed meanwhile; reload" };
  await writeAudit(ctx, "EODVerified", { companyId: row.companyId, module: "CRM-04", recordId: row._id, work: row.atmId + " " + row.date });
  await writeAudit(ctx, "EODLocked", { companyId: row.companyId, module: "CRM-04", recordId: row._id, work: row.atmId + " " + row.date });
  return { ok: true };
}

async function postOpsEodByIdVerify(ctx) {
  if (!canApproveApplication(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
  const row = await loadEod(ctx);
  if (ctx.body.returnToDraft) {
    if (row.status !== "Submitted") return { status: 400, body: { error: "only a Submitted EOD can be returned" } };
    if (String(row.submittedBy) === String(ctx.user._id) && !isAdmin(ctx.user)) return { status: 403, body: { error: "the submitter cannot return the same EOD" } };
    const reason = String(ctx.body.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "reason required to return an EOD" } };
    const back = await repo.ops_eod.updateOne({ _id: row._id, status: "Submitted" }, { $set: { status: "Draft", returnReason: reason } });
    if (!back.matchedCount) return { status: 409, body: { error: "EOD changed meanwhile; reload" } };
    await writeAudit(ctx, "EODReturned", { companyId: row.companyId, module: "CRM-04", recordId: row._id, work: reason });
    await require("../notices/notices.service")
      .notify(row.companyId, [row.submittedBy, row.createdBy], { kind: "eod", title: "EOD returned: " + row.atmId + " " + row.date, body: reason, link: { page: "ops", id: String(row._id), type: "EOD", date: row.date }, key: "eod-returned:" + row._id + ":" + Date.now() })
      .catch(() => {});
    return { status: 200, body: { ok: true } };
  }
  const r = await verifyEodRow(ctx, row);
  if (r.error) return { status: r.status, body: { error: r.error } };
  return { status: 200, body: { ok: true } };
}

async function postOpsEodVerifyDay(ctx) {
  if (!canApproveApplication(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
  const date = normDate(ctx.body.date);
  if (!date) return { status: 400, body: { error: "date required" } };
  const rows = await scopedList(ctx, "ops_eod", { date, status: "Submitted" });
  let verified = 0;
  const skipped = [];
  for (const row of rows) {
    const atm = row.atmRef ? await repo.atms.findById(row.atmRef) : null;
    if (atm && !atmInProject(ctx.user, atm)) continue;
    const r = await verifyEodRow(ctx, row);
    if (r.ok) verified++;
    else skipped.push(row.atmId + " (" + r.error + ")");
  }
  if (!verified && !skipped.length) return { status: 400, body: { error: "nothing submitted for " + date } };
  return { status: 200, body: { ok: true, verified, skipped } };
}

async function patchOpsEodByIdAdminCorrect(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const row = await loadEod(ctx);
  const reason = String(ctx.body.reason || "").trim();
  if (!reason) return { status: 400, body: { error: "reason required" } };
  const errors = [];
  const input = eodInput({ ...row, ...ctx.body }, errors);
  input.opening = ctx.body.opening !== undefined ? numField(ctx.body.opening, "opening", errors) : row.opening;
  if (errors.length) return { status: 400, body: { error: errors.map((e) => e.column + ": " + e.reason).join("; ") } };
  const prev = await previousClosing(row.companyId, row.atmId, row.date);
  const set = {
    ...input,
    ...eodCalc(input),
    openingMismatch: prev !== null && prev !== input.opening,
    adminCorrected: { by: ctx.user._id, at: new Date(), reason },
    updatedAt: new Date(),
  };
  await repo.ops_eod.updateById(row._id, { $set: set });
  await carryClosingForward(row.companyId, row.atmId, row.date, set.closing);
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "EODAdminCorrected", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before, after: set, work: reason });
  return { status: 200, body: { ok: true } };
}

async function getOpsOverage(ctx) {
  const rows = await scopedList(ctx, "overage_deposits", {});
  const docs = rows.length
    ? await repo.documents.list({ parentType: "overage", parentId: { $in: rows.map((r) => r._id) } }, { projection: { data: 0 }, sort: { version: -1 } })
    : [];
  return { status: 200, body: { rows: rows.map((r) => ({ ...r, proofs: docs.filter((d) => String(d.parentId) === String(r._id)) })) } };
}

async function postOpsOverage(request) {
  const ctx = newCtx(request);
  const errors = [];
  const date = normDate(request.body.date);
  if (!date) return { status: 400, body: { error: "date required" } };
  const r = await resolveAtm(ctx, request.body.atmId, date);
  if (r.error) return { status: 400, body: { error: r.error.reason } };
  const amount = numField(request.body.amount, "amount", errors);
  if (errors.length || amount <= 0) return { status: 400, body: { error: "amount must be a positive number" } };
  const utr = String(request.body.utr || "").trim();
  if (utr && (await repo.overage_deposits.findOne({ companyId: ctx.companyId, utr }))) {
    return { status: 409, body: { error: "UTR " + utr + " is already logged" } };
  }
  const doc = {
    companyId: ctx.companyId,
    date,
    atmId: r.atm.atmId,
    atmRef: r.atm._id,
    franchiseId: r.atm.franchiseId || null,
    frName: r.atm.franchiseeName || "",
    amount,
    mode: String(request.body.mode || ""),
    utr,
    emailFlag: !!request.body.emailFlag,
    createdBy: request.user._id,
    createdAt: new Date(),
  };
  const result = await repo.overage_deposits.insert(doc);
  await writeAudit(request, "OverageDepositLogged", { module: "CRM-04", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

module.exports = { companyOps, isAdmin, canRunOps, canConfirmTxn, numField, blank, newCtx, resolveAtm, dayLocked, rowStamp, guardRow, snapshot, saveTxn, denoLine, sideLine, saveCbr1, cbr1Totals, saveCbr2, fundingCalc, executiveLocked, saveFunding, eodCalc, eodInput, flatNotes, saveEod, previousClosing, carryClosingForward, scopedList, writeRoute, loadEod, getOpsMeta, getOpsLiveAtms, getOpsTxn, putOpsTxn, postOpsTxnConfirm, getOpsTxnExport, getOpsCbr1, putOpsCbr1, getOpsCbr2, putOpsCbr2, getOpsFunding, putOpsFunding, patchOpsFundingByIdCorrect, getOpsEod, putOpsEod, postOpsEodByIdSubmit, postOpsEodByIdVerify, postOpsEodVerifyDay, getOpsDay, getOpsPrefill, markLocked, patchOpsEodByIdAdminCorrect, getOpsOverage, postOpsOverage };
