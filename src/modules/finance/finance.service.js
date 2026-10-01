const { ObjectId } = require("mongodb");
const { AppError } = require("../../middlewares/errors");
const { isFieldStaff, isOfficeAdmin, officeRole, companyScope, canApproveApplication, can } = require("../../middlewares/rbac");
const { MONTH_RE, GSTIN_RE, CB_KINDS, CB_STATUSES, PAY_KINDS, PAY_TYPES, SETTLEMENT_BANKS, GST_STATUSES, GST_PENDING_AT, SD_ADJUST_AGAINST, PAYOUT_STATUSES, PAYOUT_NEXT, QUARTERS, BS_ACCOUNT_TYPES, GST_PAYMENT_STATUSES, CB_NEXT, SD_MOVES, IFSC_RE, PAN_RE } = require("./finance.model");
const repo = require("./finance.repository");
const nextVersion = (...args) => require("../documents/documents.service").nextVersion(...args);
const { registerImporter } = require("../imports/imports.registry");
const { isAdmin } = require("../ops/ops.service");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday, normDate } = require("../../utils/dates");
const { storeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, inFranchiseScope, atmInProject, applyFranchiseFilter } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

const isFr = (u) => FRANCHISE_LAYERS.includes(u.hierarchy);

const round2 = (n) => Math.round(n * 100) / 100;

function canFinance(u) {
  return !isFieldStaff(u) && (isOfficeAdmin(u) || officeRole(u, ["Finance"]));
}

function canChargeback(u) {
  return canFinance(u) || (!isFieldStaff(u) && officeRole(u, ["ServiceProjectOps", "Executive"]));
}

async function companyUsers(companyId, pred) {
  return (await repo.users.list({ companyId, active: true })).filter(pred).map((u) => u._id);
}

// tab = FinancePage tab label, so the notice opens the right register
async function tell(ctx, companyId, { users = [], franchiseId = null, title, body = "", tab, id, key, fy }) {
  const ns = require("../notices/notices.service");
  const me = String(ctx.user._id);
  const link = { page: "finance", id: String(id), type: tab, ...(fy ? { fy } : {}) };
  const fr = franchiseId ? await ns.franchiseUsers(companyId, franchiseId) : [];
  const ids = [...users, ...fr].filter((x) => x && String(x) !== me);
  if (ids.length) await ns.notify(companyId, ids, { kind: "finance", title, body, link, key: key ? key + ":" + Date.now() : undefined }).catch(() => {});
}

const verifiers = (companyId) => companyUsers(companyId, (u) => canApproveApplication(u) && !isFr(u));
const financeDesk = (companyId) => companyUsers(companyId, (u) => officeRole(u, ["Finance"]) || u.hierarchy === "Admin");

function fyOf(month) {
  const y = Number(month.slice(0, 4));
  const start = Number(month.slice(5, 7)) >= 4 ? y : y - 1;
  return start + "-" + String(start + 1).slice(2);
}

function fyMonths(fy) {
  const s = Number(fy.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    return (m >= 4 ? s : s + 1) + "-" + String(m).padStart(2, "0");
  });
}

function monthEnd(month) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

function maskCard(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length < 10) return "*".repeat(Math.max(d.length - 4, 0)) + d.slice(-4);
  return d.slice(0, 6) + "*".repeat(d.length - 10) + d.slice(-4);
}

function money(v, name, errors, { positive } = {}) {
  const n = Number(String(v === undefined || v === null ? "" : v).replace(/,/g, "").trim() || 0);
  if (!Number.isFinite(n) || n < 0 || (positive && n <= 0)) {
    errors.push(name + (positive ? " must be more than 0" : " must be 0 or more"));
    return 0;
  }
  return round2(n);
}

function istDateTime(v) {
  const s = String(v || "").trim();
  return new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s + "+05:30" : s);
}

function texts(b, keys) {
  const out = {};
  for (const k of keys) if (b[k] !== undefined) out[k] = String(b[k] === null ? "" : b[k]).trim();
  return out;
}

async function atmFacts(ctx, companyId, atmId) {
  if (!String(atmId || "").trim()) return {};
  const a = await resolveAtm(ctx, companyId, atmId);
  if (a.error) return { error: a.error };
  return { atmId: a.atm.atmId, siteId: a.atm.siteId || "", cashLiveDate: a.atm.cashLiveDate || "", location: a.atm.city || "", state: a.atm.state || "", hitachiCode: a.atm.hitachiCode || "" };
}

function fail(errors) {
  return { status: 400, body: { error: errors.join("; ") } };
}

async function resolveFranchise(ctx, companyId, raw) {
  let id = raw ? oid(raw) : null;
  if (isFr(ctx.user) && !id) id = ctx.user.franchiseId;
  if (!id) return { error: "franchise required" };
  const node = await repo.franchises.findOne({ _id: id, companyId });
  if (!node) return { error: "franchise not in this company" };
  if (!(await inFranchiseScope(ctx.user, node._id))) return { error: "own franchise only" };
  return { node };
}

async function resolveAtm(ctx, companyId, atmId) {
  const id = String(atmId || "").trim();
  if (!id) return { error: "ATM ID required" };
  const atm = await repo.atms.findOne({ companyId, atmId: id });
  if (!atm) return { error: "ATM ID " + id + " is not in this company's ATM Master" };
  if (isFr(ctx.user) && !(await inFranchiseScope(ctx.user, atm.franchiseId))) return { error: "own ATMs only" };
  if (!atmInProject(ctx.user, atm)) return { error: "ATM " + id + " is outside your projects" };
  return { atm };
}

function fileIn(b) {
  if (!b || !b.file || !b.file.data) return null;
  const f = checkFile(b.file.fileName, b.file.data);
  return f.error ? { error: f.error } : { fileName: f.name, mime: f.mime, buf: f.data };
}

async function saveDoc(ctx, companyId, parentType, parentId, franchiseId, type, file) {
  const version = await nextVersion(companyId, parentId, type);
  const r = await repo.documents.insert({
    companyId,
    parentType,
    parentId,
    type,
    version,
    fileName: file.fileName,
    mime: file.mime,
    ...(await storeFile(file.buf, file.fileName, file.mime)),
    status: "Documents Submitted",
    verificationStatus: "Under Verification",
    franchiseId: franchiseId || null,
    uploadedBy: ctx.user._id,
    uploadedAt: new Date(),
    gps: null,
    capturedAt: null,
    expiry: null,
    rejectionReason: "",
  });
  await writeAudit(ctx, "FinanceFileUploaded", { companyId, module: "CRM-04", recordId: r.insertedId, work: parentType + " " + type + " v" + version });
  return { id: r.insertedId, version };
}

async function withFiles(rows, parentType) {
  if (!rows.length) return rows;
  const docs = await repo.documents.list({ parentType, parentId: { $in: rows.map((r) => r._id) } }, { projection: { data: 0 }, sort: { version: -1 } });
  return rows.map((r) => ({ ...r, files: docs.filter((d) => String(d.parentId) === String(r._id)) }));
}

async function scoped(ctx, name, extra, sort) {
  const filter = { companyId: oid(ctx.user.companyId), ...(extra || {}) };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  return repo.collection(name).list(filter, { sort: sort || { createdAt: -1 }, limit: 1000 });
}

async function loadRow(ctx, name) {
  const row = await repo.collection(name).findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) {
    throw new AppError(404, "not found");
  }
  if (!(await inFranchiseScope(ctx.user, row.franchiseId))) {
    throw new AppError(403, "own records only");
  }
  return row;
}

async function nextNumber(companyId, prefix, month) {
  const company = await repo.companies.findById(companyId);
  const key = prefix + ":" + companyId + ":" + month;
  const r = await repo.counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  const seq = (r && r.value ? r.value : r).seq;
  return prefix + "-" + ((company && company.code) || "CO") + "-" + month.replace("-", "") + "-" + String(seq).padStart(4, "0");
}

async function sdRefresh(sdId) {
  const sd = await repo.security_deposits.findById(sdId);
  if (!sd) return;
  const settled = await repo.payments.list({ kind: "SD", securityDepositId: sdId, status: "Settled" });
  const received = round2(settled.reduce((s, p) => s + p.amount, 0));
  const moves = sd.movements || [];
  const refunded = round2(moves.filter((m) => m.action === "refund").reduce((s, m) => s + m.amount, 0));
  const adjusted = round2(moves.filter((m) => m.action === "adjust").reduce((s, m) => s + m.amount, 0));
  const held = round2(received - refunded - adjusted);
  let status = received <= 0 ? "Pending" : received < sd.amountDue ? "Partially Received" : "Received";
  if (refunded + adjusted > 0) status = held <= 0 ? "Refunded/Adjusted" : "Partly Refunded/Adjusted";
  await repo.security_deposits.updateById(sdId, { $set: { received, refunded, adjusted, held, balance: round2(Math.max(sd.amountDue - received, 0)), status, updatedAt: new Date() } });
}

async function findFranchiseByKey(companyId, key) {
  const k = String(key || "").trim();
  if (!k) return null;
  const byId = oid(k);
  if (byId && /^[a-f0-9]{24}$/i.test(k)) {
    const n = await repo.franchises.findOne({ _id: byId, companyId });
    if (n) return n;
  }
  return repo.franchises.findOne({ companyId, name: k });
}

registerImporter("payout", {
  headers: ["franchise", "month", "amount", "loiCode", "atmId", "panName", "emailSubject", "remark", "revenue", "expenses"],
  required: ["franchise", "month", "amount"],
  allOrNothing: true,
  canImport: canFinance,
  denied: "payout import is Finance / Admin only",
  event: "PayoutImported",
  module: "CRM-04",
  rule: "all-or-nothing: any bad row rejects the whole file and nothing is written",
  async validate(ctx, input, seen) {
    const errors = [];
    const node = await findFranchiseByKey(ctx.companyId, input.franchise);
    if (!node) errors.push({ column: "franchise", reason: "franchise not found in this company: " + input.franchise });
    const month = String(input.month || "").trim();
    if (!MONTH_RE.test(month)) errors.push({ column: "month", reason: "month must be YYYY-MM" });
    const amount = Number(String(input.amount || "").replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) errors.push({ column: "amount", reason: "amount must be more than 0" });
    const money = {};
    for (const k of ["revenue", "expenses"]) {
      const raw = String(input[k] === undefined ? "" : input[k]).replace(/,/g, "").trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) errors.push({ column: k, reason: k + " must be 0 or more" });
      else money[k] = round2(n);
    }
    if (node && MONTH_RE.test(month)) {
      const key = String(node._id) + " " + month;
      if (seen.has(key)) errors.push({ column: "franchise", reason: "same franchise and month twice in this file" });
      seen.add(key);
      const acct = await repo.payout_accounts.findOne({ companyId: ctx.companyId, franchiseId: node._id });
      if (!acct || acct.status !== "Verified") errors.push({ column: "franchise", reason: "payout account not verified for " + node.name });
      const dup = await repo.payouts.findOne({ companyId: ctx.companyId, franchiseId: node._id, month, status: { $nin: ["Rejected", "Failed"] } });
      if (dup) errors.push({ column: "month", reason: "payout already exists for " + node.name + " " + month + " (" + dup.status + ")" });
    }
    if (errors.length) return { errors };
    const atmId = String(input.atmId || "").trim();
    if (atmId && !(await repo.atms.findOne({ companyId: ctx.companyId, atmId }))) return { errors: [{ column: "atmId", reason: "ATM " + atmId + " not in the ATM Master" }] };
    return {
      value: { franchiseId: node._id, franchiseName: node.name, month, amount: round2(amount), remark: String(input.remark || ""), atmId, ...money, ...texts(input, ["loiCode", "panName", "emailSubject"]) },
    };
  },
  async save(ctx, v, batchId) {
    const acct = await repo.payout_accounts.findOne({ companyId: ctx.companyId, franchiseId: v.franchiseId, status: "Verified" });
    if (!acct) return { errors: [{ column: "franchise", reason: "payout account not verified for " + v.franchiseName }] };
    const dup = await repo.payouts.findOne({ companyId: ctx.companyId, franchiseId: v.franchiseId, month: v.month, status: { $nin: ["Rejected", "Failed"] } });
    if (dup) return { errors: [{ column: "month", reason: "payout already exists for " + v.franchiseName + " " + v.month + " (" + dup.status + ")" }] };
    const now = new Date();
    const payoutId = new ObjectId();
    const cbs = await repo.chargebacks.list({ companyId: ctx.companyId, franchiseId: v.franchiseId, status: "Accepted", billedIn: null }, { sort: { complaintDate: 1 } });
    const picked = [];
    let deduction = 0;
    for (const c of cbs) {
      if (deduction + c.disputeAmount > v.amount) break;
      // claim first so a charge-back taken by a GST bill or another payout in the meantime is not deducted twice
      const claim = await repo.chargebacks.updateOne({ _id: c._id, billedIn: null }, { $set: { billedIn: payoutId, billedKind: "payout" } });
      if (!claim.modifiedCount) continue;
      deduction = round2(deduction + c.disputeAmount);
      picked.push(c._id);
    }
    const release = () => repo.chargebacks.updateMany({ billedIn: payoutId }, { $set: { billedIn: null, billedKind: null } });
    await repo.payouts.insert({
      _id: payoutId,
      companyId: ctx.companyId,
      ...v,
      chargeBackDeduction: deduction,
      chargeBackIds: picked,
      netAmount: round2(v.amount - deduction),
      accountRef: acct._id,
      status: "Pending",
      utr: "",
      importBatchId: batchId,
      history: [{ at: now, by: ctx.user._id, to: "Pending", remark: "imported" + (deduction ? "; charge-back " + deduction + " deducted" : "") }],
      createdBy: ctx.user._id,
      createdAt: now,
    }).catch(async (err) => {
      await release();
      throw err;
    });
    return { ok: true, key: v.franchiseName + " " + v.month + (deduction ? " (charge-back −" + deduction + ")" : "") };
  },
});

async function generateGstBill(companyId, user, node, b) {
  const errors = [];
  const month = String(b.month || "").trim();
  if (!MONTH_RE.test(month)) errors.push("month must be YYYY-MM");
  const gstin = String(b.gstin || node.gstin || "").trim().toUpperCase();
  if (!GSTIN_RE.test(gstin)) errors.push("GSTIN is not valid");
  const grossAmount = money(b.grossAmount, "gross amount", errors, { positive: true });
  const gstRate = b.gstRate === undefined || b.gstRate === "" ? 18 : money(b.gstRate, "GST rate", errors);
  if (gstRate > 28) errors.push("GST rate above 28%");
  const tds = money(b.tds, "TDS", errors);
  const dispute = money(b.dispute, "dispute", errors);
  const gstDeduction = money(b.gstDeduction, "GST deduction", errors);
  if (errors.length) return { errors };
  if (String(b.atmId || "").trim() && !String(b.sapCode || "").trim()) {
    const atm = await repo.atms.findOne({ companyId, atmId: String(b.atmId).trim() }, { projection: { sapCode: 1, siteId: 1 } });
    if (atm) b = { ...b, sapCode: atm.sapCode || "", siteId: b.siteId || atm.siteId || "" };
  }
  const key = { companyId, franchiseId: node._id, month };
  const existing = await repo.gst_bills.findOne(key);
  if (existing && existing.status !== "Generated") return { errors: ["bill is " + existing.status + "; cannot regenerate"] };

  const eods = await repo.ops_eod.list({ companyId, franchiseId: node._id, status: "Verified", date: { $regex: "^" + month } }, { projection: { shortage: 1 } });
  const shortage = round2(eods.reduce((s, e) => s + (e.shortage || 0), 0));
  const billedHere = existing ? [{ billedIn: null }, { billedIn: existing._id }] : [{ billedIn: null }];
  const cbs = await repo.chargebacks.list({ companyId, franchiseId: node._id, status: { $in: ["Accepted", "Closed"] }, $or: billedHere, txnDate: { $lte: monthEnd(month) } });
  const chargeBack = round2(cbs.reduce((s, c) => s + c.disputeAmount, 0));
  const gstAmount = round2((grossAmount * gstRate) / 100);
  const net = round2(grossAmount + gstAmount - tds - shortage - dispute - chargeBack - gstDeduction);
  if (net < 0) return { errors: ["deductions exceed the bill amount (net " + net + ")"] };
  const now = new Date();
  const set = {
    franchiseName: node.name,
    gstin,
    grossAmount,
    gstRate,
    gstAmount,
    deductions: { tds, shortage, dispute, chargeBack, gstDeduction },
    ...texts(b, ["siteId", "atmId", "sapCode", "frInvoiceNo"]),
    chargeBackIds: cbs.map((c) => c._id),
    shortageEodCount: eods.length,
    net,
    status: "Generated",
    pendingAt: "Pending at FR End",
    remark: String(b.remark || ""),
    generatedBy: user._id,
    updatedAt: now,
  };
  if (b.importBatchId) set.importBatchId = b.importBatchId;
  const insertOnly = existing ? {} : { billNo: await nextNumber(companyId, "GST", month), createdAt: now, paid: false, utr: "" };
  await repo.gst_bills.updateOne(key, { $set: set, $setOnInsert: insertOnly }, { upsert: true });
  const row = await repo.gst_bills.findOne(key);
  const cbIds = cbs.map((c) => c._id);
  if (existing) await repo.chargebacks.updateMany({ billedIn: existing._id, _id: { $nin: cbIds } }, { $set: { billedIn: null } });
  if (cbs.length) await repo.chargebacks.updateMany({ _id: { $in: cbIds }, $or: billedHere }, { $set: { billedIn: row._id, billedKind: "gst" } });
  return { row, set, existing };
}

registerImporter("GST-list", {
  headers: ["franchise", "month", "gstin", "grossAmount", "gstRate", "tds", "dispute", "gstDeduction", "siteId", "atmId", "sapCode", "frInvoiceNo", "remark"],
  required: ["franchise", "month", "gstin", "grossAmount"],
  canImport: canFinance,
  denied: "GST list import is Finance / Admin only",
  event: "GSTListImported",
  module: "CRM-04",
  rule: "accept good rows, reject bad rows; a Generated bill for the same franchise + month is regenerated; Submitted or later bills are refused",
  async save(ctx, input, batchId) {
    const node = await findFranchiseByKey(ctx.companyId, input.franchise);
    if (!node) return { errors: [{ column: "franchise", reason: "franchise not found in this company: " + input.franchise }] };
    const r = await generateGstBill(ctx.companyId, ctx.user, node, { ...input, importBatchId: batchId });
    if (r.errors) return { errors: r.errors.map((reason) => ({ column: "", reason })) };
    return { ok: true, key: r.row.billNo };
  },
});

async function getFinanceMeta(ctx) {
  return { status: 200, body: {
    cbKinds: CB_KINDS,
    cbStatuses: CB_STATUSES,
    payKinds: PAY_KINDS,
    payTypes: PAY_TYPES,
    settlementBanks: SETTLEMENT_BANKS,
    gstStatuses: GST_STATUSES,
    gstPendingAt: GST_PENDING_AT,
    sdAdjustAgainst: SD_ADJUST_AGAINST,
    payoutStatuses: PAYOUT_STATUSES,
    payoutNext: PAYOUT_NEXT,
    cbNext: CB_NEXT,
    quarters: QUARTERS,
    bsAccountTypes: BS_ACCOUNT_TYPES.filter(Boolean),
    gstPaymentStatuses: GST_PAYMENT_STATUSES.filter(Boolean),
    currentFy: fyOf(istToday().slice(0, 7)),
    finance: canFinance(ctx.user),
    chargeback: canChargeback(ctx.user),
    verifier: canApproveApplication(ctx.user),
    admin: isAdmin(ctx.user),
    export: isAdmin(ctx.user) || can(ctx.user, "Export", "CRM-04"),
  } };
}

async function getFinanceChargebacks(ctx) {
  const today = istToday();
  const rows = await scoped(ctx, "chargebacks", {});
  return { status: 200, body: {
    rows: rows.map((r) => ({
      ...r,
      pendingSinceDays: ["Open", "Under Review"].includes(r.status) ? Math.max(Math.floor((new Date(today) - new Date(r.complaintDate)) / 86400000), 0) : null,
    })),
  } };
}

async function postFinanceChargebacks(ctx) {
  if (!canChargeback(ctx.user)) return { status: 403, body: { error: "Finance / Ops only" } };
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body;
  const errors = [];
  const a = await resolveAtm(ctx, companyId, b.atmId);
  if (a.error) errors.push(a.error);
  const kind = CB_KINDS.includes(b.kind) ? b.kind : "Charge back";
  const complaintDate = normDate(b.complaintDate);
  const txnDate = normDate(b.txnDate);
  if (!complaintDate) errors.push("complaint date required");
  if (!txnDate) errors.push("transaction date required");
  if (complaintDate && txnDate && txnDate > complaintDate) errors.push("transaction date is after complaint date");
  const txnAmount = money(b.txnAmount, "transaction amount", errors, { positive: true });
  const disputeAmount = money(b.disputeAmount === undefined || b.disputeAmount === "" ? b.txnAmount : b.disputeAmount, "dispute amount", errors);
  if (disputeAmount > txnAmount) errors.push("dispute amount cannot exceed transaction amount");
  const tlfRrn = String(b.tlfRrn || "").trim();
  if (!tlfRrn) errors.push("TLF / RRN required");
  if (errors.length) return fail(errors);
  if (await repo.chargebacks.findOne({ companyId, atmId: a.atm.atmId, tlfRrn })) return { status: 409, body: { error: "RRN " + tlfRrn + " is already logged for " + a.atm.atmId } };
  const doc = {
    companyId,
    kind,
    complaintDate,
    atmId: a.atm.atmId,
    atmRef: a.atm._id,
    site: a.atm.siteId || a.atm.city || "",
    franchiseId: a.atm.franchiseId || null,
    franchiseName: a.atm.franchiseeName || "",
    complainant: String(b.complainant || ""),
    txnDate,
    txnTime: String(b.txnTime || ""),
    txnAmount,
    disputeAmount,
    cardMasked: maskCard(b.cardNumber),
    tlfRrn,
    ejStatus: String(b.ejStatus || ""),
    mobile: String(b.mobile || "").trim(),
    frEmail: String(b.frEmail || "").trim(),
    state: String(b.state || "").trim(),
    complaintSubject: String(b.complaintSubject || "").trim(),
    cameraFootageRequested: !!b.cameraFootageRequested,
    remark: String(b.remark || ""),
    status: "Open",
    billedIn: null,
    createdBy: ctx.user._id,
    createdAt: new Date(),
  };
  const r = await repo.chargebacks.insert(doc);
  await writeAudit(ctx, "ChargeBackLogged", { companyId, module: "CRM-04", recordId: r.insertedId, work: kind + " " + doc.atmId + " RRN " + tlfRrn });
  return { status: 200, body: { id: String(r.insertedId) } };
}

async function patchFinanceChargebacksById(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const row = await loadRow(ctx, "chargebacks");
  const b = ctx.body;
  // once deducted, the only change left is closing it (Accepted -> Closed), with an optional remark
  if (row.billedIn && !(row.status === "Accepted" && b.status === "Closed")) return { status: 400, body: { error: "already deducted in a GST bill or payout; locked" } };
  const set = { updatedAt: new Date() };
  const fields = row.billedIn ? ["remark"] : ["ejStatus", "remark", "mobile", "frEmail", "state", "complaintSubject"];
  fields.forEach((k) => b[k] !== undefined && (set[k] = String(b[k])));
  if (b.cameraFootageRequested !== undefined && !row.billedIn) set.cameraFootageRequested = !!b.cameraFootageRequested;
  let event = "ChargeBackUpdated";
  if (b.status !== undefined && b.status !== row.status) {
    if (!(CB_NEXT[row.status] || []).includes(b.status)) return { status: 400, body: { error: row.status + " cannot move to " + b.status } };
    if (b.status === "Rejected" && !String(b.remark || "").trim()) return { status: 400, body: { error: "remark required to reject" } };
    if (b.status === "Closed" && !row.billedIn) return { status: 400, body: { error: "close after the charge-back is deducted in a GST bill" } };
    set.status = b.status;
    set.decidedBy = ctx.user._id;
    set.decidedAt = new Date();
    event = "ChargeBackStatusChanged";
  }
  await repo.chargebacks.updateById(row._id, { $set: set });
  await writeAudit(ctx, event, { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { status: row.status }, after: set, work: row.tlfRrn });
  if (["Accepted", "Rejected"].includes(set.status)) await tell(ctx, row.companyId, { franchiseId: row.franchiseId, title: "Charge-back " + set.status.toLowerCase() + ": ATM " + row.atmId + " RRN " + row.tlfRrn, body: set.status === "Accepted" ? "₹" + row.disputeAmount + " will be deducted in the next GST bill" : set.remark || "", tab: "Charge-back", id: row._id });
  return { status: 200, body: { ok: true } };
}

async function getFinanceSecurityDeposits(ctx) {
  return { status: 200, body: { rows: await scoped(ctx, "security_deposits", {}) } };
}

async function postFinanceSecurityDeposits(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const companyId = oid(ctx.user.companyId);
  const f = await resolveFranchise(ctx, companyId, ctx.body.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const errors = [];
  const amountDue = money(ctx.body.amountDue, "amount due", errors, { positive: true });
  if (errors.length) return fail(errors);
  const label = String(ctx.body.label || "Security deposit").trim();
  if (await repo.security_deposits.findOne({ companyId, franchiseId: f.node._id, label })) return { status: 409, body: { error: "security deposit '" + label + "' already exists for " + f.node.name } };
  const af = await atmFacts(ctx, companyId, ctx.body.atmId);
  if (af.error) return { status: 400, body: { error: af.error } };
  const extra = texts(ctx.body, ["siteId", "projectCode", "franchiseeNo", "hpyAccount", "accountHolder"]);
  const doc = {
    companyId, franchiseId: f.node._id, franchiseName: f.node.name, label, amountDue, received: 0, balance: amountDue, status: "Pending", remark: String(ctx.body.remark || ""),
    atmId: af.atmId || "", cashLiveDate: af.cashLiveDate || "", ...extra, siteId: extra.siteId || af.siteId || "",
    createdBy: ctx.user._id, createdAt: new Date(),
  };
  const r = await repo.security_deposits.insert(doc);
  await writeAudit(ctx, "SecurityDepositCreated", { companyId, module: "CRM-04", recordId: r.insertedId, after: doc });
  return { status: 200, body: { id: String(r.insertedId) } };
}

async function postFinanceSecurityDepositsByIdSettle(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const row = await loadRow(ctx, "security_deposits");
  const b = ctx.body;
  const errors = [];
  if (!SD_MOVES.includes(b.action)) errors.push("action must be refund or adjust");
  const amount = money(b.amount, "amount", errors, { positive: true });
  const reason = String(b.reason || "").trim();
  if (!reason) errors.push("reason required");
  const move = { action: b.action, amount, reason, by: ctx.user._id, at: new Date() };
  if (b.action === "refund") {
    move.utr = String(b.utr || "").trim().toUpperCase();
    if (!move.utr) errors.push("refund UTR required");
  } else if (b.action === "adjust") {
    move.against = String(b.against || "").trim();
    if (!SD_ADJUST_AGAINST.includes(move.against)) errors.push("adjust against must be " + SD_ADJUST_AGAINST.join(" / "));
  }
  if (errors.length) return fail(errors);
  const held = round2((row.received || 0) - (row.refunded || 0) - (row.adjusted || 0));
  if (amount > held) return { status: 400, body: { error: "only " + held + " of this deposit is held; cannot " + b.action + " " + amount } };
  const claimed = await repo.security_deposits.updateOne(
    { _id: row._id, $expr: { $gte: [{ $add: [{ $subtract: [{ $ifNull: ["$received", 0] }, { $sum: { $ifNull: ["$movements.amount", []] } }] }, 0.001] }, amount] } },
    { $push: { movements: move } },
  );
  if (!claimed.matchedCount) return { status: 409, body: { error: "deposit changed meanwhile; reload and check what is still held" } };
  await sdRefresh(row._id);
  await writeAudit(ctx, b.action === "refund" ? "SecurityDepositRefunded" : "SecurityDepositAdjusted", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { held }, after: move, work: row.franchiseName + " " + row.label });
  return { status: 200, body: { ok: true, held: round2(held - amount) } };
}

async function getFinancePayments(ctx) {
  const extra = PAY_KINDS.includes(ctx.query.kind) ? { kind: ctx.query.kind } : {};
  return { status: 200, body: { rows: await withFiles(await scoped(ctx, "payments", extra), "payment") } };
}

// Two SD payments saved at once could both pass the "still due" check, so the deposit is held while one is checked
// and stored. A lock older than 30 seconds is treated as abandoned.
async function postFinancePayments(ctx) {
  if (!canFinance(ctx.user) && !isFr(ctx.user)) return { status: 403, body: { error: "Finance or franchisee only" } };
  const sdId = ctx.body.kind === "SD" ? oid(ctx.body.securityDepositId) : null;
  if (!sdId) return submitPayment(ctx);
  const now = new Date();
  const lock = await repo.security_deposits.updateOne(
    { _id: sdId, companyId: oid(ctx.user.companyId), $or: [{ paymentLockAt: null }, { paymentLockAt: { $lt: new Date(now.getTime() - 30000) } }] },
    { $set: { paymentLockAt: now } },
  );
  if (!lock.matchedCount) {
    if (!(await repo.security_deposits.findOne({ _id: sdId, companyId: oid(ctx.user.companyId) }))) return submitPayment(ctx);
    return { status: 409, body: { error: "another payment for this deposit is being saved; try again in a moment" } };
  }
  try {
    return await submitPayment(ctx);
  } finally {
    await repo.security_deposits.updateOne({ _id: sdId, paymentLockAt: now }, { $unset: { paymentLockAt: "" } });
  }
}

async function submitPayment(ctx) {
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body;
  const errors = [];
  const kind = b.kind;
  if (!PAY_KINDS.includes(kind)) return { status: 400, body: { error: "kind must be SD or CLF" } };
  const doc = { companyId, kind, status: "Submitted", createdBy: ctx.user._id, createdAt: new Date() };
  if (kind === "SD") {
    const sd = await repo.security_deposits.findOne({ _id: oid(b.securityDepositId), companyId });
    if (!sd || !(await inFranchiseScope(ctx.user, sd.franchiseId))) return { status: 400, body: { error: "choose a security deposit of your franchise" } };
    if (sd.balance <= 0) return { status: 400, body: { error: "security deposit already fully received" } };
    const inFlight = await repo.payments.list({ kind: "SD", securityDepositId: sd._id, status: { $in: ["Submitted", "Approved"] } }, { projection: { amount: 1 } });
    const open = round2(sd.balance - inFlight.reduce((s, p) => s + (p.amount || 0), 0));
    if (money(b.amount, "amount", []) > open) errors.push("amount is more than the deposit still due (" + Math.max(open, 0) + " after payments awaiting settlement)");
    doc.securityDepositId = sd._id;
    doc.franchiseId = sd.franchiseId;
    doc.franchiseName = sd.franchiseName;
    doc.type = b.type;
    if (!PAY_TYPES.includes(b.type)) errors.push("type must be NEFT, RTGS or IMPS");
    doc.bank = String(b.bank || "").trim();
    doc.account = String(b.account || "").trim();
    doc.ifsc = String(b.ifsc || "").trim().toUpperCase();
    doc.accountHolder = String(b.accountHolder || "").trim();
    if (!doc.bank || !doc.account) errors.push("bank and account required");
    if (!IFSC_RE.test(doc.ifsc)) errors.push("IFSC must look like ABCD0123456");
  } else {
    if (b.installment !== undefined && b.installment !== "") {
      const n = Number(b.installment);
      if (!Number.isInteger(n) || n < 1 || n > 10) errors.push("installment must be 1 to 10");
      else doc.installment = n;
    }
    doc.bank = String(b.bank || "").trim();
    doc.accountHolder = String(b.accountHolder || "").trim();
    const a = await resolveAtm(ctx, companyId, b.atmId);
    if (a.error) errors.push(a.error);
    else {
      doc.atmId = a.atm.atmId;
      doc.site = a.atm.siteId || a.atm.city || "";
      doc.franchiseId = a.atm.franchiseId || null;
      doc.franchiseName = a.atm.franchiseeName || "";
    }
    doc.hpyAccount = String(b.hpyAccount || "").trim();
    doc.settlementBank = b.settlementBank;
    if (!doc.hpyAccount) errors.push("HPY account required");
    if (!SETTLEMENT_BANKS.includes(b.settlementBank)) errors.push("settlement bank must be " + SETTLEMENT_BANKS.join(" / "));
  }
  doc.amount = money(b.amount, "amount", errors, { positive: true });
  doc.paidAt = istDateTime(b.paidAt);
  if (Number.isNaN(doc.paidAt.getTime())) errors.push("payment date / time required");
  else if (doc.paidAt > new Date(Date.now() + 5 * 60 * 1000)) errors.push("payment date / time is in the future");
  doc.txnNumber = String(b.txnNumber || "").trim().toUpperCase();
  if (!doc.txnNumber) errors.push("TXN / UTR number required");
  const file = fileIn(b);
  if (!file) errors.push("payment proof file required");
  else if (file.error) errors.push(file.error);
  if (errors.length) return fail(errors);
  if (await repo.payments.findOne({ companyId, txnNumber: doc.txnNumber, status: { $ne: "Rejected" } })) return { status: 409, body: { error: "UTR " + doc.txnNumber + " is already recorded" } };
  const r = await repo.payments.insert(doc);
  await saveDoc(ctx, companyId, "payment", r.insertedId, doc.franchiseId, kind + " payment proof", file);
  await writeAudit(ctx, "PaymentSubmitted", { companyId, module: "CRM-04", recordId: r.insertedId, work: kind + " " + doc.amount + " UTR " + doc.txnNumber });
  await tell(ctx, companyId, { users: await verifiers(companyId), title: kind + " payment to verify: ₹" + doc.amount, body: "UTR " + doc.txnNumber, tab: "Payments", id: r.insertedId });
  return { status: 200, body: { id: String(r.insertedId) } };
}

async function patchFinancePaymentsById(ctx) {
  const row = await loadRow(ctx, "payments");
  const action = ctx.body.action;
  const set = { updatedAt: new Date() };
  let event;
  if (action === "approve" || action === "reject") {
    if (!canApproveApplication(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
    if (String(row.createdBy) === String(ctx.user._id) && !isAdmin(ctx.user)) return { status: 403, body: { error: "the person who entered the payment cannot verify it" } };
    if (row.status !== "Submitted") return { status: 400, body: { error: "payment is " + row.status } };
    if (action === "approve") {
      set.status = "Approved";
      event = "PaymentApproved";
    } else {
      const reason = String(ctx.body.reason || "").trim();
      if (!reason) return { status: 400, body: { error: "reason required" } };
      set.status = "Rejected";
      set.rejectReason = reason;
      event = "PaymentRejected";
    }
    set.verifiedBy = ctx.user._id;
    set.verifiedAt = new Date();
  } else if (action === "settle") {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    if (row.status !== "Approved") return { status: 400, body: { error: "only an Approved payment can be settled" } };
    set.status = "Settled";
    set.settledBy = ctx.user._id;
    set.settledAt = new Date();
    event = "PaymentSettled";
  } else {
    return { status: 400, body: { error: "action must be approve, reject or settle" } };
  }
  const moved = await repo.payments.updateOne({ _id: row._id, status: row.status }, { $set: set });
  if (!moved.matchedCount) return { status: 409, body: { error: "payment changed meanwhile; reload" } };
  if (row.kind === "SD") await sdRefresh(row.securityDepositId);
  await writeAudit(ctx, event, { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { status: row.status }, after: set, work: row.kind + " UTR " + row.txnNumber });
  const what = row.kind + " payment ₹" + row.amount + " (UTR " + row.txnNumber + ")";
  if (set.status === "Approved") await tell(ctx, row.companyId, { users: await financeDesk(row.companyId), title: "Payment approved — settle: " + what, tab: "Payments", id: row._id });
  else await tell(ctx, row.companyId, { users: [row.createdBy], franchiseId: row.franchiseId, title: "Payment " + set.status.toLowerCase() + ": " + what, body: set.rejectReason || "", tab: "Payments", id: row._id });
  return { status: 200, body: { ok: true } };
}

async function getFinanceBankStatements(ctx) {
  const companyId = oid(ctx.user.companyId);
  const fy = /^\d{4}-\d{2}$/.test(String(ctx.query.fy)) ? String(ctx.query.fy) : fyOf(istToday().slice(0, 7));
  const rows = await withFiles(await scoped(ctx, "bank_statements", { fy }, { month: 1 }), "bankStatement");
  const nodeFilter = { companyId, layer: "Franchise" };
  await applyFranchiseFilter(ctx.user, nodeFilter, "_id");
  const nodes = await repo.franchises.list(nodeFilter, { projection: { name: 1 } });
  const current = istToday().slice(0, 7);
  const months = fyMonths(fy).filter((m) => m <= current);
  const have = new Set(rows.map((r) => String(r.franchiseId) + " " + r.month));
  const pending = [];
  nodes.forEach((n) => months.forEach((m) => !have.has(String(n._id) + " " + m) && pending.push({ franchiseId: n._id, franchiseName: n.name, month: m })));
  return { status: 200, body: { fy, rows, pending } };
}

async function postFinanceBankStatements(ctx) {
  if (!canFinance(ctx.user) && !isFr(ctx.user)) return { status: 403, body: { error: "Finance or franchisee only" } };
  const companyId = oid(ctx.user.companyId);
  const f = await resolveFranchise(ctx, companyId, ctx.body.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  if (f.node.layer !== "Franchise") return { status: 400, body: { error: "choose the franchise the statement belongs to" } };
  const month = String(ctx.body.month || "");
  if (!MONTH_RE.test(month)) return { status: 400, body: { error: "month must be YYYY-MM" } };
  if (month > istToday().slice(0, 7)) return { status: 400, body: { error: "month is in the future" } };
  const file = fileIn(ctx.body);
  if (!file) return { status: 400, body: { error: "statement file required" } };
  if (file.error) return { status: 400, body: { error: file.error } };
  const key = { companyId, franchiseId: f.node._id, month };
  const existing = await repo.bank_statements.findOne(key);
  if (existing && existing.financeStatus === "Checked" && !canFinance(ctx.user)) return { status: 400, body: { error: "statement already checked by Finance" } };
  const af = await atmFacts(ctx, companyId, ctx.body.atmId);
  if (af.error) return { status: 400, body: { error: af.error } };
  const extra = texts(ctx.body, ["hitachiCode", "location", "state", "accountType"]);
  if (extra.accountType !== undefined && !BS_ACCOUNT_TYPES.includes(extra.accountType)) return { status: 400, body: { error: "account type must be " + BS_ACCOUNT_TYPES.filter(Boolean).join(" / ") } };
  const facts = af.atmId ? { atmId: af.atmId, clDate: af.cashLiveDate, location: af.location, state: af.state, hitachiCode: af.hitachiCode } : {};
  Object.keys(extra).forEach((k) => extra[k] === "" && delete extra[k]);
  await repo.bank_statements.updateOne(
    key,
    {
      $set: { fy: fyOf(month), franchiseName: f.node.name, ...facts, ...extra, uploadStatus: "Uploaded", financeStatus: "Pending", uploadedBy: ctx.user._id, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  const row = await repo.bank_statements.findOne(key);
  const d = await saveDoc(ctx, companyId, "bankStatement", row._id, f.node._id, "Bank statement", file);
  await writeAudit(ctx, "BankStatementUploaded", { companyId, module: "CRM-04", recordId: row._id, work: f.node.name + " " + month + " v" + d.version });
  if (isFr(ctx.user)) await tell(ctx, companyId, { users: await financeDesk(companyId), title: "Bank statement to check: " + f.node.name + " " + month, tab: "Bank statements", id: row._id, fy: fyOf(month) });
  return { status: 200, body: { id: String(row._id), version: d.version } };
}

async function patchFinanceBankStatementsById(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const row = await loadRow(ctx, "bank_statements");
  const status = ctx.body.financeStatus;
  if (!["Pending", "Checked", "Query"].includes(status)) return { status: 400, body: { error: "Finance A/C status must be Pending, Checked or Query" } };
  const remark = String(ctx.body.remark || "").trim();
  if (status === "Query" && !remark) return { status: 400, body: { error: "remark required for a query" } };
  const set = { financeStatus: status, financeRemark: remark, checkedBy: ctx.user._id, updatedAt: new Date(), ...texts(ctx.body, ["actionToBeTaken", "accountType"]) };
  if (set.accountType !== undefined && !BS_ACCOUNT_TYPES.includes(set.accountType)) return { status: 400, body: { error: "account type must be " + BS_ACCOUNT_TYPES.filter(Boolean).join(" / ") } };
  await repo.bank_statements.updateById(row._id, { $set: set });
  await writeAudit(ctx, "BankStatementChecked", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { financeStatus: row.financeStatus }, after: set });
  if (status === "Query") await tell(ctx, row.companyId, { franchiseId: row.franchiseId, title: "Query on bank statement " + row.month + " — please re-upload", body: remark, tab: "Bank statements", id: row._id, fy: row.fy || fyOf(row.month) });
  return { status: 200, body: { ok: true } };
}

async function getFinanceTds(ctx) {
  return { status: 200, body: { rows: await withFiles(await scoped(ctx, "tds_letters", {}, { fy: -1, quarter: -1 }), "tds") } };
}

async function postFinanceTds(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const companyId = oid(ctx.user.companyId);
  const f = await resolveFranchise(ctx, companyId, ctx.body.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const fy = String(ctx.body.fy || "");
  const quarter = String(ctx.body.quarter || "");
  if (!/^\d{4}-\d{2}$/.test(fy) || Number(fy.slice(5)) !== (Number(fy.slice(2, 4)) + 1) % 100) return { status: 400, body: { error: "F.Y. must look like 2026-27" } };
  if (!QUARTERS.includes(quarter)) return { status: 400, body: { error: "quarter must be Q1–Q4" } };
  const file = fileIn(ctx.body);
  if (!file) return { status: 400, body: { error: "TDS letter file required" } };
  if (file.error) return { status: 400, body: { error: file.error } };
  const key = { companyId, franchiseId: f.node._id, fy, quarter };
  await repo.tds_letters.updateOne(
    key,
    { $set: { franchiseName: f.node.name, projectRef: ctx.body.projectId ? oid(ctx.body.projectId) : null, remark: String(ctx.body.remark || ""), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), createdBy: ctx.user._id } },
    { upsert: true }
  );
  const row = await repo.tds_letters.findOne(key);
  const d = await saveDoc(ctx, companyId, "tds", row._id, f.node._id, "TDS letter", file);
  await writeAudit(ctx, "TDSLetterUploaded", { companyId, module: "CRM-04", recordId: row._id, work: f.node.name + " " + fy + " " + quarter + " v" + d.version });
  await tell(ctx, companyId, { franchiseId: f.node._id, title: "TDS certificate available: " + fy + " " + quarter, tab: "TDS", id: row._id });
  return { status: 200, body: { id: String(row._id), version: d.version } };
}

async function getFinanceGstBills(ctx) {
  return { status: 200, body: { rows: await withFiles(await scoped(ctx, "gst_bills", {}, { month: -1 }), "gstBill") } };
}

async function putFinanceGstBills(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body;
  const f = await resolveFranchise(ctx, companyId, b.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const r = await generateGstBill(companyId, ctx.user, f.node, b);
  if (r.errors) return fail(r.errors);
  await writeAudit(ctx, "GSTBillGenerated", { companyId, module: "CRM-04", recordId: r.row._id, before: r.existing ? { net: r.existing.net } : null, after: r.set, work: r.row.billNo });
  await tell(ctx, companyId, { franchiseId: f.node._id, title: "GST bill " + r.row.billNo + " ready — print, sign and upload", body: r.row.month + " · net ₹" + r.set.net, tab: "GST bills", id: r.row._id });
  return { status: 200, body: { id: String(r.row._id), billNo: r.row.billNo, net: r.set.net } };
}

async function patchFinanceGstBillsById(ctx) {
  const row = await loadRow(ctx, "gst_bills");
  const b = ctx.body;
  const set = { updatedAt: new Date() };
  if (row.status === "Completed" && b.action !== "details") return { status: 400, body: { error: "bill completed; locked" } };
  if (b.action === "submit") {
    if (!canFinance(ctx.user) && !isFr(ctx.user)) return { status: 403, body: { error: "not allowed" } };
    if (!["Generated", "Pending"].includes(row.status)) return { status: 400, body: { error: "bill is " + row.status } };
    const file = fileIn(b);
    if (file && file.error) return { status: 400, body: { error: file.error } };
    if (file) await saveDoc(ctx, row.companyId, "gstBill", row._id, row.franchiseId, "Signed GST bill", file);
    const signed = await repo.documents.count({ parentType: "gstBill", parentId: row._id, type: "Signed GST bill" });
    if (!signed) return { status: 400, body: { error: "upload the printed, stamped and signed bill" } };
    set.status = "Submitted";
    set.pendingAt = "Pending at Hitachi End";
    set.submittedAt = new Date();
  } else if (b.action === "process") {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    if (row.status !== "Submitted") return { status: 400, body: { error: "only a Submitted bill can go Under Processing" } };
    set.status = "Under Processing";
  } else if (b.action === "complete") {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    if (row.status !== "Under Processing") return { status: 400, body: { error: "only a bill Under Processing can be completed" } };
    const utr = String(b.utr || "").trim().toUpperCase();
    if (!utr) return { status: 400, body: { error: "UTR required to mark Paid" } };
    set.status = "Completed";
    set.pendingAt = "Done";
    set.paid = true;
    set.utr = utr;
    set.paidAt = new Date();
    const errs = [];
    set.paidAmount = b.paidAmount === undefined || b.paidAmount === "" ? row.net : money(b.paidAmount, "paid amount", errs);
    if (errs.length) return fail(errs);
    set.paymentStatus = set.paidAmount >= row.net ? "Paid" : "Partly Paid";
  } else if (b.action === "details") {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    const completed = row.status === "Completed";
    Object.assign(set, texts(b, completed ? ["sapCode", "frInvoiceNo", "paymentStatus"] : ["sapCode", "frInvoiceNo", "paymentStatus", "siteId", "atmId"]));
    if (completed && (b.siteId !== undefined || b.atmId !== undefined)) return { status: 400, body: { error: "bill completed; site and ATM are locked" } };
    if (set.paymentStatus !== undefined && !GST_PAYMENT_STATUSES.includes(set.paymentStatus)) return { status: 400, body: { error: "payment status must be " + GST_PAYMENT_STATUSES.filter(Boolean).join(" / ") } };
    if (b.paidAmount !== undefined && b.paidAmount !== "") {
      const errs = [];
      set.paidAmount = money(b.paidAmount, "paid amount", errs);
      if (errs.length) return fail(errs);
      if (set.paidAmount < 0) return { status: 400, body: { error: "paid amount cannot be negative" } };
      const derived = set.paidAmount <= 0 ? "Unpaid" : set.paidAmount >= row.net ? "Paid" : "Partly Paid";
      if (set.paymentStatus && set.paymentStatus !== derived) return { status: 400, body: { error: "payment status must be " + derived + " for a paid amount of " + set.paidAmount + " against " + row.net } };
      set.paymentStatus = derived;
    }
    if (completed) {
      const reason = String(b.reason || "").trim();
      if (!reason) return { status: 400, body: { error: "reason required to change a completed bill" } };
      set.lastEditReason = reason;
    }
  } else if (b.action === "pending") {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    const remark = String(b.remark || "").trim();
    if (!remark) return { status: 400, body: { error: "remark required" } };
    if (!GST_PENDING_AT.filter((x) => x !== "Done").includes(b.pendingAt)) return { status: 400, body: { error: "say where it is pending" } };
    set.status = "Pending";
    set.pendingAt = b.pendingAt;
    set.pendingRemark = remark;
  } else {
    return { status: 400, body: { error: "action must be submit, process, complete, pending or details" } };
  }
  const moved = await repo.gst_bills.updateOne({ _id: row._id, status: row.status }, { $set: set });
  if (!moved.matchedCount) return { status: 409, body: { error: "bill changed meanwhile; reload" } };
  await writeAudit(ctx, "GSTBillStatusChanged", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { status: row.status }, after: set, work: row.billNo });
  const gstNote = { tab: "GST bills", id: row._id };
  if (set.status === "Submitted" && isFr(ctx.user)) await tell(ctx, row.companyId, { ...gstNote, users: await financeDesk(row.companyId), title: "Signed GST bill submitted: " + row.billNo, body: row.franchiseName + " " + row.month });
  else if (set.status === "Pending" && set.pendingAt === "Pending at FR End") await tell(ctx, row.companyId, { ...gstNote, franchiseId: row.franchiseId, title: "GST bill " + row.billNo + " needs your action", body: set.pendingRemark });
  else if (set.status === "Completed") await tell(ctx, row.companyId, { ...gstNote, franchiseId: row.franchiseId, title: "GST bill " + row.billNo + " paid ₹" + set.paidAmount, body: "UTR " + set.utr });
  return { status: 200, body: { ok: true } };
}

async function getFinancePayoutAccounts(ctx) {
  return { status: 200, body: { rows: await withFiles(await scoped(ctx, "payout_accounts", {}), "payoutAccount") } };
}

async function putFinancePayoutAccounts(ctx) {
  if (!canFinance(ctx.user) && !isFr(ctx.user)) return { status: 403, body: { error: "Finance or franchisee only" } };
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body;
  const f = await resolveFranchise(ctx, companyId, b.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const errors = [];
  const v = {
    accountName: String(b.accountName || "").trim(),
    accountNumber: String(b.accountNumber || "").replace(/\s/g, ""),
    ifsc: String(b.ifsc || "").trim().toUpperCase(),
    pan: String(b.pan || "").trim().toUpperCase(),
    bank: String(b.bank || "").trim(),
  };
  if (!v.accountName || !v.bank) errors.push("account name and bank required");
  if (!/^\d{9,18}$/.test(v.accountNumber)) errors.push("account number must be 9–18 digits");
  if (!IFSC_RE.test(v.ifsc)) errors.push("IFSC must look like ABCD0123456");
  if (!PAN_RE.test(v.pan)) errors.push("PAN must look like ABCDE1234F");
  if (errors.length) return fail(errors);
  const key = { companyId, franchiseId: f.node._id };
  const existing = await repo.payout_accounts.findOne(key);
  const file = fileIn(b);
  if (!file && !existing) return { status: 400, body: { error: "cancelled cheque or passbook file required" } };
  if (file && file.error) return { status: 400, body: { error: file.error } };
  const changed = !existing || file || Object.keys(v).some((k) => existing[k] !== v[k]);
  if (!changed) return { status: 200, body: { ok: true, id: String(existing._id) } };
  await repo.payout_accounts.updateOne(
    key,
    { $set: { ...v, franchiseName: f.node.name, status: "Pending", confirmationMailSent: false, updatedBy: ctx.user._id, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  const row = await repo.payout_accounts.findOne(key);
  if (file) await saveDoc(ctx, companyId, "payoutAccount", row._id, f.node._id, "Cancelled cheque / passbook", file);
  await writeAudit(ctx, existing ? "PayoutAccountChanged" : "PayoutAccountCreated", {
    companyId,
    module: "CRM-04",
    recordId: row._id,
    before: existing ? { accountNumber: existing.accountNumber, ifsc: existing.ifsc, status: existing.status } : null,
    after: { accountNumber: v.accountNumber, ifsc: v.ifsc, status: "Pending" },
  });
  await tell(ctx, companyId, { users: await companyUsers(companyId, isAdmin), title: "Payout account to verify: " + f.node.name, body: v.bank + " · " + v.ifsc, tab: "Payout accounts", id: row._id });
  return { status: 200, body: { id: String(row._id) } };
}

async function patchFinancePayoutAccountsById(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin verifies payout accounts" } };
  const row = await loadRow(ctx, "payout_accounts");
  if (row.status !== "Pending") return { status: 400, body: { error: "account is " + row.status } };
  const set = { updatedAt: new Date(), verifiedBy: ctx.user._id, verifiedAt: new Date() };
  let event;
  if (ctx.body.action === "verify") {
    const proof = await repo.documents.count({ parentType: "payoutAccount", parentId: row._id });
    if (!proof) return { status: 400, body: { error: "cancelled cheque / passbook missing" } };
    set.status = "Verified";
    event = "PayoutAccountVerified";
  } else if (ctx.body.action === "reject") {
    const reason = String(ctx.body.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "reason required" } };
    set.status = "Rejected";
    set.rejectReason = reason;
    event = "PayoutAccountRejected";
  } else {
    return { status: 400, body: { error: "action must be verify or reject" } };
  }
  await repo.payout_accounts.updateById(row._id, { $set: set });
  if (set.status === "Verified") {
    await repo.franchises.updateOne(
      { _id: row.franchiseId, companyId: row.companyId },
      { $set: { payoutAccount: { accountName: row.accountName, accountNumber: row.accountNumber, ifsc: row.ifsc, bank: row.bank, pan: row.pan, verifiedAt: set.verifiedAt } } }
    );
  }
  await writeAudit(ctx, event, { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { status: row.status }, after: set, work: row.franchiseName });
  await tell(ctx, row.companyId, { franchiseId: row.franchiseId, title: "Payout account " + set.status.toLowerCase(), body: set.rejectReason || row.bank + " · " + row.ifsc, tab: "Payout accounts", id: row._id });
  if (set.status !== "Verified") return { status: 200, body: { ok: true } };
  const mail = require("../mail/mail.service");
  const lu = (await repo.lookups.findOne({ companyId: row.companyId })) || {};
  const to = [...(lu.payoutConfirmEmails || []), ...(await mail.franchiseEmail(row.companyId, row.franchiseId, null))];
  if (!to.length) return { status: 200, body: { ok: true, confirmationMail: "not queued: no company or franchise email on file" } };
  const vars = { franchise: row.franchiseName || "", accountName: row.accountName, bank: row.bank, account: "XXXX" + String(row.accountNumber || "").slice(-4), ifsc: row.ifsc, today: istToday() };
  const mailId = await mail.queueAutoMail(row.companyId, { templateKey: "payout-account", vars, to, franchiseId: row.franchiseId }).catch(() => null);
  if (!mailId) return { status: 200, body: { ok: true, confirmationMail: "not queued" } };
  await repo.payout_accounts.updateById(row._id, { $set: { confirmationMailSent: true, confirmationMailId: mailId } });
  return { status: 200, body: { ok: true, confirmationMail: "queued to " + [...new Set(to)].join(", ") } };
}

async function getFinancePayouts(ctx) {
  return { status: 200, body: { rows: await scoped(ctx, "payouts", {}, { month: -1, franchiseName: 1 }) } };
}

async function getFinancePnl(ctx) {
  const from = MONTH_RE.test(String(ctx.query.from)) ? String(ctx.query.from) : "0000-00";
  const to = MONTH_RE.test(String(ctx.query.to)) ? String(ctx.query.to) : "9999-99";
  const rows = await scoped(ctx, "payouts", { month: { $gte: from, $lte: to }, status: { $nin: ["Rejected", "Failed"] } }, { month: 1 });
  const byFr = new Map();
  for (const p of rows) {
    const k = String(p.franchiseId);
    if (!byFr.has(k)) byFr.set(k, { franchiseId: k, franchise: p.franchiseName, months: [] });
    const hasBooks = p.revenue !== undefined || p.expenses !== undefined;
    const deduction = p.chargeBackDeduction || 0;
    const profit = round2(hasBooks ? (p.revenue || 0) - (p.expenses || 0) - deduction : p.netAmount === undefined ? p.amount : p.netAmount);
    byFr.get(k).months.push({ month: p.month, payout: p.amount, deduction, net: p.netAmount === undefined ? p.amount : p.netAmount, revenue: p.revenue === undefined ? null : p.revenue, expenses: p.expenses === undefined ? null : p.expenses, profit, basis: hasBooks ? "revenue − expenses − charge-backs" : "net payout", status: p.status });
  }
  const list = [...byFr.values()].map((f) => {
    let run = 0;
    let longest = 0;
    f.months.forEach((m) => {
      run = m.profit < 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    });
    const total = round2(f.months.reduce((s, m) => s + m.profit, 0));
    const lossMonths = f.months.filter((m) => m.profit < 0).length;
    return { ...f, total, lossMonths, longestLossRun: longest, result: total >= 0 ? "Profit" : "Loss", consistentLoss: longest >= 3 };
  });
  list.sort((a, b) => b.total - a.total).forEach((f, i) => (f.rank = i + 1));
  const csvRows = list.flatMap((f) => f.months.map((m) => [f.rank, f.franchise, m.month, m.payout, m.deduction, m.net, m.revenue === null ? "" : m.revenue, m.expenses === null ? "" : m.expenses, m.profit, m.basis, f.total, f.result, f.consistentLoss ? "Yes" : "No"]));
  if (ctx.query.csv) {
    if (!can(ctx.user, "Export", "CRM-04") || FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return { status: 403, body: { error: "Export not granted" } };
    const head = ["rank", "franchise", "month", "payout", "chargeBackDeduction", "netPayout", "revenue", "expenses", "profit", "basis", "franchiseTotal", "result", "consistentLoss"];
    await writeAudit(ctx, "ReportExported", { module: "CRM-04", work: "franchise P&L " + from + " to " + to + " " + list.length + " franchise(s)" });
    return { status: 200, body: { fileName: "franchise-pnl.csv", csv: "\uFEFF" + [head, ...csvRows].map((r) => r.map(csvCell).join(",")).join("\n") } };
  }
  return { status: 200, body: {
    rows: list,
    top: list[0] ? list[0].franchise : null,
    inLoss: list.filter((f) => f.result === "Loss").map((f) => f.franchise),
    consistentLoss: list.filter((f) => f.consistentLoss).map((f) => f.franchise),
  } };
}

async function patchFinancePayoutsById(ctx) {
  const row = await loadRow(ctx, "payouts");
  if (ctx.body.status === undefined) {
    if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
    const set = texts(ctx.body, ["loiCode", "atmId", "panName", "emailSubject"]);
    if (!Object.keys(set).length) return { status: 400, body: { error: "nothing to change" } };
    if (set.atmId && !(await repo.atms.findOne({ companyId: row.companyId, atmId: set.atmId }))) return { status: 400, body: { error: "ATM " + set.atmId + " not in the ATM Master" } };
    await repo.payouts.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
    const before = {};
    Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
    await writeAudit(ctx, "PayoutUpdated", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before, after: set, work: row.franchiseName + " " + row.month });
    return { status: 200, body: { ok: true } };
  }
  const to = String(ctx.body.status || "");
  if (!(PAYOUT_NEXT[row.status] || []).includes(to)) return { status: 400, body: { error: row.status + " cannot move to " + (to || "?") } };
  const verifierStep = ["Approved", "Rejected"].includes(to);
  if (verifierStep ? !canApproveApplication(ctx.user) || isFr(ctx.user) : !canFinance(ctx.user)) {
    return { status: 403, body: { error: verifierStep ? "Verifier / Admin only" : "Finance only" } };
  }
  if (to === "Approved" && String(row.createdBy) === String(ctx.user._id) && !isAdmin(ctx.user)) {
    return { status: 403, body: { error: "the importer cannot approve the same payout" } };
  }
  const reason = String(ctx.body.reason || "").trim();
  if (["On Hold", "Rejected", "Failed"].includes(to) && !reason) return { status: 400, body: { error: "reason required" } };
  const set = { status: to, updatedAt: new Date() };
  if (to === "Paid") {
    const utr = String(ctx.body.utr || "").trim().toUpperCase();
    if (!utr) return { status: 400, body: { error: "UTR required to mark Paid" } };
    set.utr = utr;
    set.paidAt = new Date();
  }
  if (to === "Processing") {
    const acct = await repo.payout_accounts.findById(row.accountRef);
    if (!acct || acct.status !== "Verified") return { status: 400, body: { error: "payout account is no longer verified" } };
  }
  const moved = await repo.payouts.updateOne({ _id: row._id, status: row.status }, { $set: set, $push: { history: { at: new Date(), by: ctx.user._id, from: row.status, to, remark: reason || set.utr || "" } } });
  if (!moved.matchedCount) return { status: 409, body: { error: "payout changed meanwhile; reload" } };
  if (to === "Rejected" && (row.chargeBackIds || []).length) await repo.chargebacks.updateMany({ _id: { $in: row.chargeBackIds }, billedIn: row._id }, { $set: { billedIn: null, billedKind: null } });
  await writeAudit(ctx, "PayoutStatusChanged", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before: { status: row.status }, after: set, work: row.franchiseName + " " + row.month });
  const poNote = { tab: "Payouts", id: row._id };
  const net = row.netAmount === undefined ? row.amount : row.netAmount;
  if (["Paid", "Failed", "On Hold"].includes(to)) await tell(ctx, row.companyId, { ...poNote, franchiseId: row.franchiseId, title: "Payout " + row.month + " " + to.toLowerCase() + ": ₹" + net, body: set.utr ? "UTR " + set.utr : reason });
  else if (to === "Approved") await tell(ctx, row.companyId, { ...poNote, users: await financeDesk(row.companyId), title: "Payout approved — process: " + row.franchiseName + " " + row.month, body: "₹" + net });
  else if (to === "Rejected") await tell(ctx, row.companyId, { ...poNote, users: [row.createdBy], title: "Payout rejected: " + row.franchiseName + " " + row.month, body: reason });
  if (to === "Paid") {
    const to = await require("../mail/mail.service").franchiseEmail(row.companyId, row.franchiseId, null);
    if (to.length) await require("../mail/mail.service").queueAutoMail(row.companyId, { templateKey: "payout", vars: { franchise: row.franchiseName || "", month: row.month, amount: row.netAmount === undefined ? row.amount : row.netAmount, utr: set.utr }, to, franchiseId: row.franchiseId }).catch(() => null);
  }
  return { status: 200, body: { ok: true } };
}

async function getFinanceExport(ctx) {
  if (!isAdmin(ctx.user) && !can(ctx.user, "Export", "CRM-04")) return { status: 403, body: { error: "Export not granted" } };
  const companyId = oid(ctx.user.companyId);
  const kind = String(ctx.query.kind || "");
  const cell = csvCell;
  const scope = { companyId };
  await applyFranchiseFilter(ctx.user, scope, "franchiseId");
  let head;
  let rows;
  if (kind === "payouts") {
    head = ["franchise", "loiCode", "atmId", "panName", "month", "amount", "chargeBackDeduction", "netAmount", "status", "utr", "emailSubject"];
    rows = (await repo.payouts.list(scope, { sort: { month: -1 } })).map((r) => [r.franchiseName, r.loiCode || "", r.atmId || "", r.panName || "", r.month, r.amount, r.chargeBackDeduction || 0, r.netAmount === undefined ? r.amount : r.netAmount, r.status, r.utr, r.emailSubject || ""]);
  } else if (kind === "gst-bills") {
    head = ["billNo", "franchise", "siteId", "atmId", "sapCode", "frInvoiceNo", "month", "gstin", "gross", "gst", "tds", "shortage", "dispute", "chargeBack", "gstDeduction", "net", "status", "pendingAt", "paidAmount", "paymentStatus", "utr"];
    rows = (await repo.gst_bills.list(scope, { sort: { month: -1 } })).map((r) => [
      r.billNo, r.franchiseName, r.siteId || "", r.atmId || "", r.sapCode || "", r.frInvoiceNo || "", r.month, r.gstin, r.grossAmount, r.gstAmount, r.deductions.tds, r.deductions.shortage, r.deductions.dispute, r.deductions.chargeBack,
      r.deductions.gstDeduction || 0, r.net, r.status, r.pendingAt, r.paidAmount === undefined ? "" : r.paidAmount, r.paymentStatus || "", r.utr,
    ]);
  } else if (kind === "payments") {
    head = ["kind", "franchise", "atmId", "installment", "amount", "type", "bank", "accountHolder", "utr", "paidAt", "settlementBank", "status"];
    rows = (await repo.payments.list(scope, { sort: { createdAt: -1 } })).map((r) => [
      r.kind, r.franchiseName, r.atmId || "", r.installment || "", r.amount, r.type || "", r.bank || "", r.accountHolder || "", r.txnNumber, r.paidAt && r.paidAt.toISOString(), r.settlementBank || "", r.status,
    ]);
  } else if (kind === "security-deposits") {
    head = ["franchise", "franchiseeNo", "label", "siteId", "atmId", "projectCode", "cashLiveDate", "hpyAccount", "accountHolder", "amountDue", "received", "held", "status"];
    rows = (await repo.security_deposits.list(scope, { sort: { createdAt: -1 } })).map((r) => [
      r.franchiseName, r.franchiseeNo || "", r.label, r.siteId || "", r.atmId || "", r.projectCode || "", r.cashLiveDate || "", r.hpyAccount || "", r.accountHolder || "", r.amountDue, r.received || 0, r.held || 0, r.status,
    ]);
  } else if (kind === "bank-statements") {
    head = ["franchise", "month", "atmId", "hitachiCode", "location", "state", "clDate", "accountType", "upload", "financeStatus", "actionToBeTaken", "remark"];
    rows = (await repo.bank_statements.list(scope, { sort: { month: -1 } })).map((r) => [
      r.franchiseName, r.month, r.atmId || "", r.hitachiCode || "", r.location || "", r.state || "", r.clDate || "", r.accountType || "", r.uploadStatus, r.financeStatus, r.actionToBeTaken || "", r.financeRemark || "",
    ]);
  } else if (kind === "chargebacks") {
    head = ["kind", "complaintDate", "atmId", "franchise", "state", "mobile", "frEmail", "complaintSubject", "txnDate", "txnAmount", "disputeAmount", "rrn", "status"];
    rows = (await repo.chargebacks.list(scope, { sort: { complaintDate: -1 } })).map((r) => [
      r.kind, r.complaintDate, r.atmId, r.franchiseName, r.state || "", r.mobile || "", r.frEmail || "", r.complaintSubject || "", r.txnDate, r.txnAmount, r.disputeAmount, r.tlfRrn, r.status,
    ]);
  } else {
    return { status: 400, body: { error: "kind must be payouts, gst-bills, payments, security-deposits, bank-statements or chargebacks" } };
  }
  await writeAudit(ctx, "FinanceExported", { companyId, module: "CRM-04", work: kind + " " + rows.length + " rows" });
  return { status: 200, body: { fileName: kind + ".csv", csv: "\uFEFF" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\n") } };
}

// one "needs attention" list per role: each section says which register tab and row it opens
async function getFinanceDesk(ctx) {
  const u = ctx.user;
  const me = String(u._id);
  const fr = isFr(u);
  const fin = canFinance(u);
  const ver = canApproveApplication(u) && !fr;
  const sections = [];
  const add = (key, title, tab, tone, rows, map) => rows.length && sections.push({ key, title, tab, tone, count: rows.length, rows: rows.slice(0, 8).map((r) => ({ id: String(r._id), ...map(r) })) });
  const pay = (r) => ({ label: r.kind + " ₹" + r.amount + " · " + (r.franchiseName || r.atmId || ""), sub: "UTR " + r.txnNumber });
  const payments = await scoped(ctx, "payments", { status: { $in: ["Submitted", "Approved", "Rejected"] } });
  if (ver) add("payVerify", "Payments to verify", "Payments", "warn", payments.filter((r) => r.status === "Submitted" && String(r.createdBy) !== me), pay);
  if (fin) add("paySettle", "Approved payments to settle", "Payments", "info", payments.filter((r) => r.status === "Approved"), pay);
  if (fr) add("payRejected", "Rejected payments — resubmit", "Payments", "bad", payments.filter((r) => r.status === "Rejected" && r.verifiedAt && Date.now() - new Date(r.verifiedAt) < 30 * 86400000), (r) => ({ ...pay(r), sub: r.rejectReason || "" }));

  const fy = fyOf(istToday().slice(0, 7));
  const bs = await scoped(ctx, "bank_statements", { financeStatus: { $in: ["Pending", "Query"] } }, { month: 1 });
  if (fin) add("bsCheck", "Bank statements to check", "Bank statements", "warn", bs.filter((r) => r.financeStatus === "Pending"), (r) => ({ label: r.franchiseName + " · " + r.month, sub: r.atmId || "", fy: r.fy }));
  add("bsQuery", fr ? "Bank statements queried — re-upload" : "Bank statements under query", "Bank statements", "bad", bs.filter((r) => r.financeStatus === "Query"), (r) => ({ label: r.franchiseName + " · " + r.month, sub: r.financeRemark || "", fy: r.fy }));
  if (fr) {
    const lastMonth = new Date(Date.UTC(Number(istToday().slice(0, 4)), Number(istToday().slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const have = await scoped(ctx, "bank_statements", { month: lastMonth });
    if (!have.length) sections.push({ key: "bsMissing", title: "Bank statement not uploaded", tab: "Bank statements", tone: "bad", count: 1, rows: [{ id: "", label: "Upload the statement for " + lastMonth, sub: "F.Y. " + fy, month: lastMonth }] });
  }

  const gst = await scoped(ctx, "gst_bills", { status: { $ne: "Completed" } }, { month: -1 });
  const gstRow = (r) => ({ label: r.billNo + " · " + r.franchiseName + " · " + r.month, sub: "net ₹" + r.net + (r.pendingRemark ? " · " + r.pendingRemark : "") });
  if (fr) add("gstSign", "GST bills to sign and upload", "GST bills", "warn", gst.filter((r) => r.status === "Generated" || (r.status === "Pending" && r.pendingAt === "Pending at FR End")), gstRow);
  if (fin) add("gstProcess", "GST bills submitted / processing", "GST bills", "info", gst.filter((r) => ["Submitted", "Under Processing"].includes(r.status)), gstRow);

  const accts = await scoped(ctx, "payout_accounts", { status: { $in: ["Pending", "Rejected"] } });
  if (isAdmin(u)) add("acctVerify", "Payout accounts to verify", "Payout accounts", "warn", accts.filter((r) => r.status === "Pending"), (r) => ({ label: r.franchiseName, sub: r.bank + " · " + r.ifsc }));
  if (fr) add("acctRejected", "Payout account rejected — fix details", "Payout accounts", "bad", accts.filter((r) => r.status === "Rejected"), (r) => ({ label: r.bank + " · " + r.ifsc, sub: r.rejectReason || "" }));

  const payouts = await scoped(ctx, "payouts", { status: { $in: ["Pending", "Approved", "Processing", "On Hold", "Failed"] } }, { month: -1 });
  const po = (r) => ({ label: r.franchiseName + " · " + r.month, sub: "net ₹" + (r.netAmount === undefined ? r.amount : r.netAmount) });
  if (ver) add("poApprove", "Payouts to approve", "Payouts", "warn", payouts.filter((r) => r.status === "Pending" && (String(r.createdBy) !== me || isAdmin(u))), po);
  if (fin) add("poProcess", "Payouts to process / pay", "Payouts", "info", payouts.filter((r) => ["Approved", "Processing"].includes(r.status)), po);
  if (fin) add("poStuck", "Payouts on hold / failed", "Payouts", "bad", payouts.filter((r) => ["On Hold", "Failed"].includes(r.status)), po);

  if (canChargeback(u) || fr) {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const cbs = await scoped(ctx, "chargebacks", { status: { $in: ["Open", "Under Review"] }, complaintDate: { $lte: cutoff } }, { complaintDate: 1 });
    add("cbOld", "Charge-backs open over 7 days", "Charge-back", "warn", cbs, (r) => ({ label: "ATM " + r.atmId + " · RRN " + r.tlfRrn, sub: r.status + " since " + r.complaintDate + " · ₹" + r.disputeAmount }));
  }
  return { status: 200, body: { sections } };
}

async function getFinanceGstPreview(ctx) {
  if (!canFinance(ctx.user)) return { status: 403, body: { error: "Finance only" } };
  const companyId = oid(ctx.user.companyId);
  const f = await resolveFranchise(ctx, companyId, ctx.query.franchiseId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const month = String(ctx.query.month || "");
  if (!MONTH_RE.test(month)) return { status: 400, body: { error: "month must be YYYY-MM" } };
  const existing = await repo.gst_bills.findOne({ companyId, franchiseId: f.node._id, month });
  const eods = await repo.ops_eod.list({ companyId, franchiseId: f.node._id, status: "Verified", date: { $regex: "^" + month } }, { projection: { shortage: 1 } });
  const billedHere = existing ? [{ billedIn: null }, { billedIn: existing._id }] : [{ billedIn: null }];
  const cbs = await repo.chargebacks.list({ companyId, franchiseId: f.node._id, status: { $in: ["Accepted", "Closed"] }, $or: billedHere, txnDate: { $lte: monthEnd(month) } }, { projection: { disputeAmount: 1 } });
  const atm = await repo.atms.findOne({ companyId, franchiseId: f.node._id }, { sort: { atmId: 1 } });
  const lastBill = f.node.gstin ? null : await repo.gst_bills.findOne({ companyId, franchiseId: f.node._id }, { sort: { month: -1 } });
  return { status: 200, body: {
    gstin: f.node.gstin || (lastBill ? lastBill.gstin : ""),
    shortage: round2(eods.reduce((s, e) => s + (e.shortage || 0), 0)),
    shortageEodCount: eods.length,
    chargeBack: round2(cbs.reduce((s, c) => s + c.disputeAmount, 0)),
    chargeBackCount: cbs.length,
    atmId: atm ? atm.atmId : "",
    siteId: atm ? atm.siteId || "" : "",
    existing: existing ? { billNo: existing.billNo, status: existing.status, grossAmount: existing.grossAmount, gstRate: existing.gstRate, tds: existing.deductions.tds, dispute: existing.deductions.dispute, gstDeduction: existing.deductions.gstDeduction || 0 } : null,
  } };
}

module.exports = { getFinanceDesk, getFinanceGstPreview, isFr, round2, canFinance, canChargeback, fyOf, fyMonths, monthEnd, maskCard, money, istDateTime, texts, atmFacts, fail, resolveFranchise, resolveAtm, fileIn, saveDoc, withFiles, scoped, loadRow, nextNumber, sdRefresh, findFranchiseByKey, generateGstBill, getFinanceMeta, getFinanceChargebacks, postFinanceChargebacks, patchFinanceChargebacksById, getFinanceSecurityDeposits, postFinanceSecurityDeposits, postFinanceSecurityDepositsByIdSettle, getFinancePayments, postFinancePayments, patchFinancePaymentsById, getFinanceBankStatements, postFinanceBankStatements, patchFinanceBankStatementsById, getFinanceTds, postFinanceTds, getFinanceGstBills, putFinanceGstBills, patchFinanceGstBillsById, getFinancePayoutAccounts, putFinancePayoutAccounts, patchFinancePayoutAccountsById, getFinancePayouts, getFinancePnl, patchFinancePayoutsById, getFinanceExport };
