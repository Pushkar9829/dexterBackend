const { can, companyScope } = require("../../middlewares/rbac");
const { registerImporter } = require("../imports/imports.registry");
const { DENOS } = require("../ops/ops.model");
const { canRunOps, resolveAtm, blank, numField, guardRow, isAdmin, newCtx } = require("../ops/ops.service");
const { MONTH_NAMES, MONTH_RE, MODELS, FUND_SPLIT, CBR1_COLS, CBR1_LABELS, SF_NOTE, KINDS, XLSX_MIME } = require("./reports.model");
const repo = require("./reports.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, applyFranchiseFilter } = require("../../utils/scope");
const { writeXlsx } = require("../../utils/xlsx");

function monthEnd(m) {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
}

function prevMonth(m) {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
}

const dmy = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4);

const monthLabel = (m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1] + " " + m.slice(0, 4);

const notesTotal = (notes) => DENOS.reduce((s, d) => s + (Number((notes || {})[d]) || 0) * d, 0);

const notesText = (notes) =>
  DENOS.filter((d) => Number((notes || {})[d]))
    .map((d) => d + "×" + notes[d])
    .join(", ");

const sum = (list, fn) => list.reduce((s, r) => s + (Number(fn(r)) || 0), 0);

const last = (list) => (list.length ? list[list.length - 1] : null);

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);

const val = (v) => (v === undefined ? null : v);

function isFranchiseUser(user) {
  return FRANCHISE_LAYERS.includes(user.hierarchy);
}

function canLoad(user) {
  return canRunOps(user) || (isFranchiseUser(user) && can(user, "Create", "CRM-04"));
}

function atmModel(atm) {
  const t = String((atm && atm.mdType) || "").trim().toUpperCase();
  return MODELS.includes(t) ? t : "FFM";
}

function errText(errors) {
  return errors.map((e) => e.column + ": " + e.reason).join("; ");
}

async function saveMonthly(ctx, input, source, batchId) {
  const month = String(input.month || "").trim();
  if (!MONTH_RE.test(month)) return { errors: [{ column: "month", reason: "month must be YYYY-MM" }] };
  if (month > istToday().slice(0, 7)) return { errors: [{ column: "month", reason: "month is in the future" }] };
  const r = await resolveAtm(ctx, input.atmId, monthEnd(month));
  if (r.error) return { errors: [r.error] };
  const key = { companyId: ctx.companyId, atmId: r.atm.atmId, month };
  const existing = await repo.ops_monthly.findOne(key);
  const errors = [];
  let fundingModel = blank(input.fundingModel) ? existing && existing.fundingModel : String(input.fundingModel).trim().toUpperCase();
  if (!fundingModel) {
    const earlier = await repo.ops_monthly.find({ companyId: ctx.companyId, atmId: r.atm.atmId, month: { $lt: month }, fundingModel: { $in: MODELS } }).sort({ month: -1 }).limit(1).next();
    fundingModel = (earlier && earlier.fundingModel) || atmModel(r.atm);
  }
  if (!MODELS.includes(fundingModel)) errors.push({ column: "fundingModel", reason: "fundingModel must be FFM or SF" });
  const v = {};
  ["dmsBalance", ...FUND_SPLIT].forEach((f) => (v[f] = blank(input[f]) ? (existing ? val(existing[f]) : null) : numField(input[f], f, errors)));
  FUND_SPLIT.forEach((f) => v[f] < 0 && errors.push({ column: f, reason: "cannot be negative" }));
  if (errors.length) return { errors };
  const totalFunding = FUND_SPLIT.some((f) => v[f] !== null) ? FUND_SPLIT.reduce((s, f) => s + (v[f] || 0), 0) : null;
  await repo.ops_monthly.updateOne(
    key,
    {
      $set: {
        ...v,
        fundingModel,
        totalFunding,
        remarks: blank(input.remarks) ? (existing && existing.remarks) || "" : String(input.remarks).trim(),
        atmRef: r.atm._id,
        franchiseId: r.atm.franchiseId || null,
        franchiseeName: r.atm.franchiseeName || "",
        source,
        importBatchId: batchId || null,
        updatedBy: ctx.user._id,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  const before = existing ? { fundingModel: existing.fundingModel || null, totalFunding: val(existing.totalFunding), remarks: existing.remarks || "", ...Object.fromEntries(Object.keys(v).map((k) => [k, val(existing[k])])) } : null;
  return { ok: true, key: r.atm.atmId + " " + month, before, set: { ...v, fundingModel, totalFunding } };
}

registerImporter("monthly-atm", {
  headers: ["atmId", "month", "fundingModel", "dmsBalance", "selfFund", "monthlyAdditional", "weeklyAdditional", "remarks"],
  required: ["atmId", "month"],
  canImport: canRunOps,
  denied: "Ops / Admin import monthly files",
  save: (ctx, input, batchId) => saveMonthly(ctx, input, "import", batchId),
  event: "MonthlyImported",
  module: "CRM-04",
  rule: "accept good rows, reject bad rows; same Company + ATM + month replaces the previous value",
});

function flatDenos(body, prefix) {
  if (body[prefix + "Notes"] && typeof body[prefix + "Notes"] === "object") return body[prefix + "Notes"];
  const out = {};
  DENOS.forEach((d) => body[prefix + d] !== undefined && (out[d] = body[prefix + d]));
  return out;
}

async function saveLoading(ctx, rawBody, source, batchId) {
  const body = { ...rawBody, withdrawalNotes: flatDenos(rawBody, "withdrawal"), rejectNotes: flatDenos(rawBody, "reject"), cassetteNotes: flatDenos(rawBody, "cassette"), loadingNotes: flatDenos(rawBody, "loading") };
  const g = await guardRow(ctx, body);
  if (g.errors) return g;
  if (g.date > istToday()) return { errors: [{ column: "date", reason: "date is in the future" }] };
  const key = { companyId: ctx.companyId, atmId: g.atm.atmId, date: g.date };
  const existing = await repo.ops_loading.findOne(key);
  if (existing && !ctx.admin && (existing.calcMismatch || existing.adminCorrected)) return { errors: [{ column: "date", reason: "this day's loading is locked; ask Admin to correct it" }] };
  const errors = [];
  const input = loadingInput(body, errors);
  if (errors.length) return { errors };
  input.lastDayFundAuto = blank(body.lastDayFund);
  if (input.lastDayFundAuto) input.lastDayFund = await previousFund(ctx.companyId, g.atm.atmId, g.date);
  const calc = loadingCalc(input);
  if (calc.withdrawalNotesTotal !== input.withdrawal) {
    return { errors: [{ column: "withdrawal", reason: "denominations total " + calc.withdrawalNotesTotal + " must equal the withdrawal amount " + input.withdrawal }] };
  }
  const set = { ...input, ...calc, source, importBatchId: batchId || null, atmRef: g.atm._id, franchiseId: g.atm.franchiseId || null, franchiseeName: g.atm.franchiseeName || "", updatedBy: ctx.user._id, updatedAt: new Date() };
  await repo.ops_loading.updateOne(key, { $set: set, $setOnInsert: { createdAt: new Date(), createdBy: ctx.user._id } }, { upsert: true });
  await carryLoadingForward(ctx.companyId, g.atm.atmId, g.date);
  const before = existing ? Object.fromEntries(Object.keys(input).map((k) => [k, existing[k] === undefined ? null : existing[k]])) : null;
  return { ok: true, key: g.atm.atmId + " " + g.date, set, before };
}

registerImporter("daily-loading", {
  headers: ["atmId", "date", "lastDayFund", "hpyFund", "withdrawal", ...["withdrawal", "reject", "cassette", "loading"].flatMap((p) => DENOS.map((d) => p + d)), "wlaClosing", "remarks"],
  required: ["atmId", "date", "withdrawal"],
  canImport: canRunOps,
  denied: "Ops / Admin import daily loading files",
  save: (ctx, input, batchId) => saveLoading(ctx, input, "import", batchId),
  event: "LoadingImported",
  module: "CRM-04",
  rule: "accept good rows, reject bad rows; same Company + ATM + date replaces the previous value unless Admin locked it",
});

function loadingInput(body, errors) {
  const notes = (m, label) => {
    const out = {};
    DENOS.forEach((d) => {
      out[d] = numField((m || {})[d], label + " " + d, errors);
      if (out[d] < 0 || !Number.isInteger(out[d])) errors.push({ column: label + " " + d, reason: "note count must be a whole number ≥ 0" });
    });
    return out;
  };
  const input = {
    lastDayFund: numField(body.lastDayFund, "lastDayFund", errors),
    hpyFund: numField(body.hpyFund, "hpyFund", errors),
    withdrawal: numField(body.withdrawal, "withdrawal", errors),
    withdrawalNotes: notes(body.withdrawalNotes, "withdrawal"),
    rejectNotes: notes(body.rejectNotes, "reject bin"),
    cassetteNotes: notes(body.cassetteNotes, "cassette"),
    loadingNotes: notes(body.loadingNotes, "loading"),
    wlaClosingEntered: blank(body.wlaClosing) ? null : numField(body.wlaClosing, "wlaClosing", errors),
    remarks: String(body.remarks || "").trim(),
  };
  ["hpyFund", "withdrawal"].forEach((f) => input[f] < 0 && errors.push({ column: f, reason: "cannot be negative" }));
  return input;
}

function loadingCalc(v) {
  const wlaClosing = v.lastDayFund + v.hpyFund - v.withdrawal;
  return {
    withdrawalNotesTotal: notesTotal(v.withdrawalNotes),
    wlaClosing,
    rejectTotal: notesTotal(v.rejectNotes),
    cassetteTotal: notesTotal(v.cassetteNotes),
    loadingTotal: notesTotal(v.loadingNotes),
    calcMismatch: wlaClosing < 0 || (v.wlaClosingEntered !== null && v.wlaClosingEntered !== wlaClosing),
  };
}

async function previousFund(companyId, atmId, date) {
  const before = { companyId, atmId, date: { $lt: date } };
  const [prev, wla] = await Promise.all([
    repo.ops_loading.findOne(before, { sort: { date: -1 } }),
    repo.ops_funding.findOne({ ...before, type: "WLA" }, { sort: { date: -1 } }),
  ]);
  if (prev && (!wla || prev.date >= wla.date)) return prev.wlaClosing;
  return wla ? wla.closingWla : 0;
}

async function carryLoadingForward(companyId, atmId, date) {
  let from = date;
  for (let i = 0; i < 62; i++) {
    const next = await repo.ops_loading.findOne({ companyId, atmId, date: { $gt: from } }, { sort: { date: 1 } });
    if (!next || !next.lastDayFundAuto || next.adminCorrected) return;
    const lastDayFund = await previousFund(companyId, atmId, next.date);
    if (lastDayFund === next.lastDayFund) return;
    const calc = loadingCalc({ ...next, lastDayFund });
    await repo.ops_loading.updateById(next._id, { $set: { lastDayFund, ...calc, updatedAt: new Date() } });
    from = next.date;
  }
}

function reportFilters(q) {
  const t = (k) => String(q[k] || "").trim();
  const d = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(t(k)) ? t(k) : "");
  return { franchiseId: t("franchiseId"), salesOfficer: t("salesOfficer"), cra: t("cra"), bank: t("bank"), fundingPath: t("fundingPath"), region: t("region"), from: d("from"), to: d("to") };
}

function filterLabel(f) {
  return Object.entries(f)
    .filter(([, v]) => v)
    .map(([k, v]) => k + "=" + v)
    .join(" ");
}

async function gather(ctx, month, atmId, f = {}) {
  const companyId = oid(ctx.user.companyId);
  const start = month + "-01";
  const end = monthEnd(month);
  const pm = prevMonth(month);
  const atmFilter = { companyId, cashLiveDate: { $ne: null } };
  if (atmId) atmFilter.atmId = atmId;
  await applyFranchiseFilter(ctx.user, atmFilter, "franchiseId");
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const atms = (await repo.atms.list(atmFilter, { sort: { atmId: 1 } })).filter(
    (a) =>
      new Date(a.cashLiveDate).toISOString().slice(0, 10) <= end &&
      (!f.franchiseId || String(a.franchiseId) === f.franchiseId) &&
      (!f.salesOfficer || same(a.salesOfficer, f.salesOfficer)) &&
      (!f.bank || same(a.bankName, f.bank)) &&
      (!f.fundingPath || same(a.fundingPath, f.fundingPath)) &&
      (!f.region || same(a.region, f.region))
  );
  const ids = atms.map((a) => a.atmId);
  const q = (name, extra, sort) =>
    repo.collection(name).list({ companyId, atmId: { $in: ids }, ...extra }, { sort: sort || { date: 1 } });
  const [eods, funding, monthly, cbr1, loading, cbr2, overage] = await Promise.all([
    q("ops_eod", { date: { $gte: pm + "-01", $lte: end } }),
    q("ops_funding", { date: { $lte: end } }),
    q("ops_monthly", { month: { $in: [pm, month] } }, { month: 1 }),
    q("ops_cbr1", { date: { $gte: start, $lte: end } }),
    q("ops_loading", { date: { $gte: start, $lte: end } }),
    q("ops_cbr2", { date: { $gte: start, $lte: end } }),
    q("overage_deposits", { date: { $gte: start, $lte: end } }),
  ]);
  const inRange = (r) => (!f.from || r.date >= f.from) && (!f.to || r.date <= f.to);
  const daily = (rows) => (f.from || f.to ? rows.filter(inRange) : rows);
  const g = {
    month,
    start,
    end,
    pm,
    pEnd: monthEnd(pm),
    atms,
    eods,
    funding: f.from || f.to ? funding.filter((r) => r.date < start || inRange(r)) : funding,
    monthly,
    cbr1: daily(cbr1).filter((r) => !f.cra || same(r.cra, f.cra)),
    loading: daily(loading),
    cbr2: daily(cbr2),
    overage: daily(overage),
  };
  const models = await repo
    .collection("ops_monthly")
    .aggregate([{ $match: { companyId, atmId: { $in: ids }, month: { $lte: month }, fundingModel: { $in: MODELS } } }, { $sort: { month: -1 } }, { $group: { _id: "$atmId", model: { $first: "$fundingModel" } } }])
    .toArray();
  g.modelOf = new Map(models.map((m) => [m._id, m.model]));
  g.proofs = g.overage.length ? new Set((await repo.documents.distinct("parentId", { parentType: "overage", parentId: { $in: g.overage.map((o) => o._id) } })).map(String)) : new Set();
  return g;
}

function summarize(g, atm) {
  const eod = g.eods.filter((r) => r.atmId === atm.atmId).sort(byDate);
  const inMonth = eod.filter((r) => r.date >= g.start);
  const prev = last(eod.filter((r) => r.date < g.start));
  const cur = last(inMonth);
  const fund = g.funding.filter((r) => r.atmId === atm.atmId).sort(byDate);
  const fundM = fund.filter((r) => r.date >= g.start);
  const wla = fund.filter((r) => r.type === "WLA");
  const wlaPrev = last(wla.filter((r) => r.date < g.start));
  const wlaEnd = last(wla);
  const mon = g.monthly.find((r) => r.atmId === atm.atmId && r.month === g.month) || {};
  const monPrev = g.monthly.find((r) => r.atmId === atm.atmId && r.month === g.pm) || {};
  const totalFunding = val(mon.totalFunding !== undefined && mon.totalFunding !== null ? mon.totalFunding : monPrev.totalFunding);
  const givenFund = sum(fundM, (r) => (r.type === "WLA" ? r.fundHpy : (r.axisLot1 || 0) + (r.axisLot2 || 0)));
  const frLoading = sum(fundM, (r) => r.frOwnFund);
  const apnaDispense = sum(inMonth, (r) => r.dispenseApna);
  const physPrev = prev ? prev.physicalTotal : null;
  const physEnd = cur ? cur.physicalTotal : null;
  const base = prev ? prev.physicalTotal : inMonth.length ? inMonth[0].opening : 0;
  const sfOverage = (phys, apna, wlaBal) => (phys === null || totalFunding === null ? null : phys - (totalFunding - (apna || 0) - (wlaBal || 0)));
  const s = {
    atmId: atm.atmId,
    frName: atm.franchiseeName || "",
    fundingModel: mon.fundingModel || monPrev.fundingModel || (g.modelOf && g.modelOf.get(atm.atmId)) || atmModel(atm),
    totalFunding,
    dmsPrev: val(monPrev.dmsBalance),
    dmsEnd: val(mon.dmsBalance),
    physPrev,
    physEnd,
    givenFund,
    settlementFund: sum(fundM.filter((r) => r.type === "WLA"), (r) => r.fundHpy),
    frLoading,
    apnaDispense,
    actualBalance: base + givenFund + frLoading - apnaDispense,
    wlaPrev: wlaPrev ? wlaPrev.closingWla : null,
    wlaEnd: wlaEnd ? wlaEnd.closingWla : null,
    apnaPrev: prev ? prev.dispenseApna : null,
    apnaEnd: cur ? cur.dispenseApna : null,
    prevEodDate: prev ? prev.date : null,
    endEodDate: cur ? cur.date : null,
    monthEndCheck: [prev && prev.date !== g.pEnd ? "opening from " + dmy(prev.date) + " not " + dmy(g.pEnd) : "", cur && cur.date !== g.end ? "closing from " + dmy(cur.date) + " not " + dmy(g.end) : "", !cur ? "no EOD in month" : ""].filter(Boolean).join("; "),
  };
  if (s.fundingModel === "SF") {
    s.overPrev = sfOverage(physPrev, s.apnaPrev, s.wlaPrev);
    s.overEnd = sfOverage(physEnd, s.apnaEnd, s.wlaEnd);
  } else {
    s.overPrev = diff(physPrev, s.dmsPrev);
    s.overEnd = diff(physEnd, s.dmsEnd);
  }
  return s;
}

const c = (key, en, hi) => ({ key, en, hi: hi || "" });

function buildReport(kind, g, admin) {
  const P = dmy(g.pEnd);
  const E = dmy(g.end);
  const ML = monthLabel(g.month);
  const withSn = (rows) => rows.map((r, i) => ({ sn: i + 1, ...r }));

  if (kind === "cbr1") {
    const rows = [];
    let sr = 0;
    g.cbr1.forEach((r) => {
      const totals = {};
      sr += 1;
      const base = { srNo: sr, date: dmy(r.date), atmId: r.atmId, location: r.location || "" };
      DENOS.forEach((d) => {
        const line = (r.denos || {})[d];
        if (!line || !Object.values(line).some(Boolean)) return;
        const row = { ...base, indent: r.indent || "", eodTime: r.eodTime || "", deno: d };
        CBR1_COLS.forEach((c) => {
          row[c + "Notes"] = line[c + "Notes"] || 0;
          row[c + "Amount"] = line[c + "Amount"] || 0;
          totals[c + "Amount"] = (totals[c + "Amount"] || 0) + (line[c + "Amount"] || 0);
        });
        rows.push(row);
      });
      ["AQS", "WLACBR"].forEach((s) => {
        const line = (r.side || {})[s];
        if (line) rows.push({ ...base, deno: s, ...line });
      });
      rows.push({ ...base, deno: "Total", ...totals, remarks: r.remarks || "", switchCounter: r.switchCounter === undefined ? null : r.switchCounter, cra: r.cra || "", fr: r.fr || "", bank: r.bank || "" });
    });
    return {
      title: "CBR 1 - " + ML,
      columns: [
        c("srNo", "Sr. No."),
        c("date", "Date"),
        c("atmId", "ATM ID"),
        c("location", "Location"),
        c("indent", "Indent / Order"),
        c("eodTime", "EOD Time"),
        c("deno", "Deno"),
        ...CBR1_COLS.flatMap((x) => [c(x + "Notes", CBR1_LABELS[x] + " notes"), c(x + "Amount", CBR1_LABELS[x] + " amount")]),
        c("remarks", "Remarks"),
        c("switchCounter", "Switch Counter (legacy)"),
        c("cra", "CRA"),
        c("fr", "FR"),
        c("bank", "Bank"),
      ],
      rows,
    };
  }

  if (kind === "cbr2") {
    return {
      title: "CBR 2 - " + ML,
      columns: [
        c("sn", "No"),
        c("date", "Date"),
        c("atmId", "ATM ID"),
        c("mfName", "MF Name"),
        c("indentNo", "Indent No"),
        c("eodTime", "EOD Time"),
        c("opening", "Opening"),
        c("dispense", "Dispense"),
        c("purge", "Purge"),
        c("overage", "Overage"),
        c("shortage", "Shortage"),
        c("physical", "Physical"),
        c("loading", "Loading"),
        c("closing", "Closing"),
        c("remarks", "Remarks"),
        c("switchBalance", "Switch Balance"),
      ],
      rows: withSn(g.cbr2.map((r) => ({ ...r, _id: undefined, date: dmy(r.date) }))),
    };
  }

  if (kind === "cbr3-wla" || kind === "cbr3-axis") {
    const wla = kind === "cbr3-wla";
    const rows = g.funding
      .filter((r) => (wla ? r.type === "WLA" : ["Axis", "ICD"].includes(r.type)) && r.date >= g.start)
      .map((r) => {
        const row = { ...r, _id: undefined, date: dmy(r.date) };
        if (!admin) {
          delete row.calcMismatch;
          delete row.adminCorrected;
        } else {
          row.calcMismatch = r.calcMismatch ? "Wrong calculation" : "";
          row.adminCorrected = r.adminCorrected ? r.adminCorrected.reason : "";
        }
        return row;
      });
    const columns = wla
      ? [
          c("date", "Date"),
          c("atmId", "ATM ID"),
          c("lastDayDispenseApna", "Last day dispense (Apna App)"),
          c("openingWla", "Opening WLA"),
          c("fundHpy", "Fund given by HPY"),
          c("withdrawal", "Withdrawal from WLA"),
          c("closingWla", "Closing WLA"),
          c("loadingCbr", "Loading as per CBR & counter"),
          c("loadingDiff", "Loading difference"),
          c("frOwnFund", "FR own loading fund"),
        ]
      : [
          c("date", "Date"),
          c("atmId", "ATM ID"),
          c("type", "Path (Axis / ICD)"),
          c("lastDayDispenseApna", "Last day dispense"),
          c("axisLot1", "1st lot"),
          c("axisLot2", "2nd lot"),
          c("loadingCbr", "Loading as per CBR"),
          c("loadingDiff", "Difference"),
          c("frOwnFund", "FR own loading"),
        ];
    if (admin) columns.push(c("calcMismatch", "Check (Admin only)"), c("adminCorrected", "Admin correction"));
    return { title: "CBR 3 / funding (" + (wla ? "WLA" : "Axis & ICD") + ") - " + ML, columns, rows };
  }

  if (kind === "overage") {
    return {
      title: "Overage Deposite - " + ML,
      columns: [c("sn", "S.N."), c("date", "Deposit Date"), c("atmId", "ATM ID"), c("frName", "FR Name"), c("amount", "Overage Amount"), c("mode", "Mode"), c("utr", "UTR / TXN"), c("attached", "Attached"), c("email", "Email")],
      rows: withSn(g.overage.map((o) => ({ date: dmy(o.date), atmId: o.atmId, frName: o.frName, amount: o.amount, mode: o.mode, utr: o.utr, attached: g.proofs.has(String(o._id)) ? "Yes" : "No", email: o.emailFlag ? "Yes" : "No" }))),
    };
  }

  if (kind === "ffm-eod" || kind === "sf-loading") {
    const model = kind === "ffm-eod" ? "FFM" : "SF";
    const rows = withSn(g.atms.map((a) => summarize(g, a)).filter((s) => s.fundingModel === model));
    const common = [c("sn", "S.N."), c("atmId", "ATM ID"), c("frName", "FR Name")];
    const tail = [
      c("frLoading", "FR Loading Fund " + ML),
      c("apnaDispense", "Apna App Dispence Fund " + ML),
      c("actualBalance", "Actual Machine Balance " + E),
    ];
    if (model === "FFM") {
      return {
        title: "Full Funding Sites - " + ML + " - EOD Report " + E,
        columns: [
          ...common,
          c("dmsPrev", "Machine Balance as per DMS @11:00 PM (" + P + ")"),
          c("physPrev", "Physical Balance as per FR @11:00 PM (" + P + ")"),
          c("overPrev", "Actual Overage as on " + P),
          c("givenFund", "HPY Given Fund " + ML),
          ...tail,
          c("dmsEnd", "Machine Balance as per DMS @11:00 PM (" + E + ")"),
          c("physEnd", "Physical Balance as per FR @11:00 PM (" + E + ")"),
          c("overEnd", "Actual Overage as on " + E),
          c("monthEndCheck", "Month-end check"),
        ],
        rows,
      };
    }
    return {
      title: "SF - " + ML + " - EOD Report " + E,
      note: SF_NOTE,
      columns: [
        ...common,
        c("totalFunding", "Total Funding"),
        c("wlaPrev", "WLA Account " + P),
        c("apnaPrev", "Apna App Dispence " + P),
        c("physPrev", "Physical Balance as per FR @11:00 PM (" + P + ")"),
        c("overPrev", "Actual Overage as on " + P),
        c("settlementFund", "Settelement Fund " + ML),
        ...tail,
        c("wlaEnd", "WLA Account " + E),
        c("apnaEnd", "Apna App Dispence " + E),
        c("physEnd", "Physical Balance as per FR @11:00 PM (" + E + ")"),
        c("overEnd", "Actual Overage as on " + E),
        c("monthEndCheck", "Month-end check"),
      ],
      rows,
    };
  }

  if (kind === "mobile-app") {
    const rows = g.atms.map((a) => {
      const s = summarize(g, a);
      return { atmId: s.atmId, fundingModel: s.fundingModel, eodPrev: s.physPrev, givenFund: s.givenFund, dispenseFund: s.apnaDispense, dmsEnd: s.dmsEnd, overageEnd: s.overEnd, eodEnd: s.physEnd, loadingFund: s.frLoading };
    });
    return {
      title: "Individual Report Format for Mobile Application",
      columns: [
        c("atmId", "ATM ID", "एटीएम आईडी"),
        c("eodPrev", "FR EOD Balance as On " + P + " - 11:00 PM", "फ्रैंचाइज़ी EOD शेष " + P + " (रात्रि 11.00 बजे)"),
        c("givenFund", "Given Fund " + ML, "दी गई धनराशि " + ML),
        c("dispenseFund", "Dispence Fund " + ML, "निकासी धनराशि " + ML),
        c("dmsEnd", "DMS Balance as On " + E + " - 11:00 PM", "DMS शेष " + E + " (रात्रि 11.00 बजे)"),
        c("overageEnd", "Overage as on " + E, "अतिरिक्त राशि " + E),
        c("eodEnd", "EOD Balance as on " + E, "EOD शेष " + E),
        c("loadingFund", "Loading Fund " + ML, "लोडिंग धनराशि " + ML),
      ],
      rows,
    };
  }

  if (kind === "mobile-loading") {
    const rows = g.loading.map((r) => {
      const row = {
        _id: r._id,
        atmId: r.atmId,
        date: r.date,
        lastDayFund: r.lastDayFund,
        hpyFund: r.hpyFund,
        withdrawal: r.withdrawal,
        withdrawalDeno: notesText(r.withdrawalNotes),
        wlaClosing: r.wlaClosing,
        rejectBin: notesText(r.rejectNotes),
        cassette: notesText(r.cassetteNotes),
        loading: notesText(r.loadingNotes),
        loadingTotal: r.loadingTotal,
        remarks: r.remarks,
      };
      if (admin) {
        row.wlaClosingEntered = r.wlaClosingEntered;
        row.calcMismatch = r.calcMismatch ? "Wrong calculation" : "";
        row.adminCorrected = r.adminCorrected ? r.adminCorrected.reason : "";
      }
      return row;
    });
    const columns = [
      c("atmId", "ATM ID", "एटीएम आईडी"),
      c("date", "Date", "तारीख"),
      c("lastDayFund", "Last Day Fund", "पिछले दिन की धनराशि"),
      c("hpyFund", "HPY Given Fund", "HPY द्वारा दी गई धनराशि"),
      c("withdrawal", "Bank Indent / Withdrawal Fund", "बैंक इंडेंट / निकासी धनराशि"),
      c("withdrawalDeno", "Denomination (= Withdrawal Amount)", "नोटों के प्रकार"),
      c("wlaClosing", "WLA Account Closing Balance", "WLA खाते का अंतिम शेष"),
      c("rejectBin", "Reject Bin", "रिजेक्ट बिन"),
      c("cassette", "Cassette", "केसेट"),
      c("loading", "Total Loading Cash", "कुल लोडिंग नकद"),
      c("loadingTotal", "Total Loading Amount", "कुल लोडिंग राशि"),
      c("remarks", "Remark", "टिप्पणी"),
    ];
    if (admin) columns.push(c("wlaClosingEntered", "WLA closing entered"), c("calcMismatch", "Check (Admin only)"), c("adminCorrected", "Admin correction"));
    return { title: "Daily Loading Status", columns, rows };
  }

  if (kind === "dlr2") {
    const rows = [];
    g.atms.forEach((atm) => {
      const s = summarize(g, atm);
      const dates = new Set();
      const eods = new Map();
      g.eods.filter((r) => r.atmId === atm.atmId && r.date >= g.start).forEach((r) => (eods.set(r.date, r), dates.add(r.date)));
      const fund = g.funding.filter((r) => r.atmId === atm.atmId && r.date >= g.start);
      fund.forEach((r) => dates.add(r.date));
      [...dates].sort().forEach((d) => {
        const e = eods.get(d);
        const f = fund.filter((r) => r.date === d);
        const w = f.find((r) => r.type === "WLA");
        const received = sum(f, (r) => (r.type === "WLA" ? r.fundHpy : (r.axisLot1 || 0) + (r.axisLot2 || 0)));
        rows.push({
          atmId: atm.atmId,
          totalFund: s.totalFunding,
          fundsDate: received ? dmy(d) : "",
          fundsReceived: received || null,
          wlaBalance: w ? w.closingWla : null,
          physical: e ? e.physicalTotal : null,
          physicalDeno: e ? notesText(e.physicalNotes) : "",
          apnaDispense: e ? e.dispenseApna : null,
          machineDispense: e ? e.dispenseMachine : null,
          rejectBox: e ? e.purgeTotal : null,
          rejectDeno: e ? notesText(e.purgeNotes) : "",
          rejectExcess: e ? e.overage : null,
          settlementDiff: e ? e.overage - e.shortage : null,
          loadingDate: e && e.loadingTotal ? dmy(d) : "",
          loadingAmount: e ? e.loadingTotal : null,
          loadingDeno: e ? notesText(e.loadingNotes) : "",
          remark: e ? [e.remarks, e.dispenseFlag ? "Apna ≠ machine dispense by " + e.dispenseDiff : ""].filter(Boolean).join("; ") : "",
        });
      });
    });
    return {
      title: "Daily Loading Register (DLR 2) - " + ML,
      columns: [
        c("sn", "S.N.", "क्र.स."),
        c("atmId", "ATM ID", "एटीएम आईडी"),
        c("totalFund", "Total Fund", "फ्रैंचाइज़ी धनराशि"),
        c("fundsDate", "Funds received date", "इंडेंट / WLA खाते में प्राप्त धनराशि दिनांक"),
        c("fundsReceived", "Funds received in Indent / Settlement in WLA Account / SR received", "इंडेंट / WLA खाते में प्राप्त कुल धनराशि"),
        c("wlaBalance", "WLA Account Balance", "WLA खाता में शेष राशि"),
        c("physical", "Physical Cash Balance available in ATM (at 23:00 hours)", "एटीएम केसेट में शेष प्राप्त कुल धनराशि (रात्रि 11.00 बजे)"),
        c("physicalDeno", "Physical cash denominations", "नोटों के प्रकार"),
        c("apnaDispense", "Actual dispense from ATM (By Customers) / Apna app as per previous Day", "पिछले दिन के अनुसार एटीएम से ग्राहक द्वारा हुई निकासी कुल धनराशी (अपना ऐप)"),
        c("machineDispense", "Dispense as per machine counters", "एटीएम मशीन काउंटर के अनुसार कुल धनराशि"),
        c("rejectBox", "Actual Amount in Reject Box / Purge Bin at the time every loading", "रिजेक्ट बॉक्स / बिन में प्राप्त कुल धनराशि (रात्रि 11.00 बजे)"),
        c("rejectDeno", "Reject box denominations", "नोटों के प्रकार"),
        c("rejectExcess", "Total Excess Amount in Reject Box / Purge Bin", "रिजेक्ट बॉक्स/पर्ज बिन में कुल अतिरिक्त राशि"),
        c("settlementDiff", "Difference (Excess/Shortage) received in Settlement", "सेटलमेंट राशि में अंतर (अधिक या कम) विवरण"),
        c("loadingDate", "Loading Date", "लोडिंग तारीख"),
        c("loadingAmount", "Amount Loaded in ATM", "एटीएम में लोड की गयी कुल धनराशि"),
        c("loadingDeno", "Loaded denominations", "नोटों के प्रकार"),
        c("remark", "Remark", "टिप्पणी"),
      ],
      rows: withSn(rows),
    };
  }

  const rows = [];
  let sn = 0;
  g.atms.forEach((atm) => {
    const dates = new Set();
    const eods = new Map();
    const cbrs = new Map();
    g.eods.filter((r) => r.atmId === atm.atmId && r.date >= g.start).forEach((r) => (eods.set(r.date, r), dates.add(r.date)));
    g.cbr1.filter((r) => r.atmId === atm.atmId).forEach((r) => (cbrs.set(r.date, r), dates.add(r.date)));
    const fund = g.funding.filter((r) => r.atmId === atm.atmId && r.date >= g.start);
    [...dates].sort().forEach((d) => {
      sn++;
      const e = eods.get(d);
      const cb = cbrs.get(d);
      const f = fund.filter((r) => r.date === d);
      const w = f.find((r) => r.type === "WLA");
      const denos = cb ? DENOS.filter((x) => x <= 500 || ((cb.denos || {})[x] && Object.values(cb.denos[x]).some(Boolean))) : [];
      denos.forEach((x) => {
        const line = (cb.denos || {})[x] || {};
        rows.push({
          sn,
          atmId: atm.atmId,
          date: dmy(d),
          deno: x,
          opening: line.openingAmount || 0,
          dispensed: line.dispensedAmount || 0,
          purge: line.purgeAmount || 0,
          physicalBefore: line.physicalAmount || 0,
          loaded: line.replenishmentAmount || 0,
          overage: line.overageAmount || 0,
          shortage: line.shortageAmount || 0,
          closing: line.closingAmount || 0,
        });
      });
      const tot = (k) => DENOS.reduce((s, x) => s + ((((cb && cb.denos) || {})[x] || {})[k + "Amount"] || 0), 0);
      const received = sum(f, (r) => (r.type === "WLA" ? r.fundHpy : (r.axisLot1 || 0) + (r.axisLot2 || 0)));
      const loaded = cb ? tot("replenishment") : e ? e.loadingTotal : 0;
      rows.push({
        sn,
        atmId: atm.atmId,
        date: dmy(d),
        deno: "Total=",
        opening: cb ? tot("opening") : e ? e.opening : null,
        dispensed: cb ? tot("dispensed") : e ? e.dispenseMachine : null,
        purge: cb ? tot("purge") : e ? e.purgeTotal : null,
        physicalBefore: cb ? tot("physical") : e ? e.physicalTotal : null,
        loaded,
        overage: cb ? tot("overage") : e ? e.overage : null,
        shortage: cb ? tot("shortage") : e ? e.shortage : null,
        closing: cb ? tot("closing") : e ? e.closing : null,
        received: received || null,
        withdrawal: w ? w.withdrawal : null,
        wlaClosing: w ? w.closingWla : null,
        cashInHand: w ? w.withdrawal - loaded : null,
        apnaDispense: e ? e.dispenseApna : null,
        physical23: e ? e.physicalTotal : null,
      });
    });
  });
  return {
    title: "DLR 3 - Counter + Physical + WLA - " + ML,
    groups: { Counter: ["opening", "dispensed"], Physical: ["purge", "physicalBefore", "loaded"] },
    columns: [
      c("sn", "S.N.", "क्र.स."),
      c("atmId", "ATM ID", "एटीएम आईडी"),
      c("date", "Date", "तारीख"),
      c("deno", "Deno", "मूल्यवर्ग / नोटों के प्रकार"),
      c("opening", "Opening Balance", "प्रारंभिक शेष"),
      c("dispensed", "Cash Dispensed", "नकद वितरण"),
      c("purge", "Cash in Purge Bin", "पर्ज बिन में नकद"),
      c("physicalBefore", "Physical Cash in ATM before Replenishment", "पुनःपूर्ति से पहले एटीएम में भौतिक नकद"),
      c("loaded", "Amount Loaded in ATM / Cash Replenishment", "एटीएम में लोड की गयी कुल धनराशि / नकद पुनःपूर्ति"),
      c("overage", "Overage", "अतिरिक्त"),
      c("shortage", "Shortage", "कमी"),
      c("closing", "Closing Balance", "समापन शेष"),
      c("received", "Funds received in Indent / Settlement in WLA Account / SR received", "इंडेंट / WLA खाते में प्राप्त कुल धनराशि / HPY Given Fund"),
      c("withdrawal", "Bank Withdrawal Amount", "बैंक से निकाली गई राशि"),
      c("wlaClosing", "WLA Account Closing Balance", "WLA खाते का अंतिम शेष"),
      c("cashInHand", "Cash in Hand", "फ्रैंचाइज़ी के पास नकदी"),
      c("apnaDispense", "Actual dispense from ATM (By Customers) / Apna app", "एटीएम से ग्राहक द्वारा हुई निकासी कुल धनराशी"),
      c("physical23", "Physical Cash Balance available in ATM (at 23:00 hours)", "एटीएम में शेष कुल धनराशि (रात्रि 11.00 बजे)"),
    ],
    rows,
  };
}

function reportCsv(rep) {
  const lines = [];
  lines.push(csvCell(rep.title));
  if (rep.note) lines.push(csvCell(rep.note));
  lines.push(rep.columns.map((x) => csvCell(x.en)).join(","));
  if (rep.columns.some((x) => x.hi)) lines.push(rep.columns.map((x) => csvCell(x.hi)).join(","));
  rep.rows.forEach((r) => lines.push(rep.columns.map((x) => csvCell(r[x.key] === null || r[x.key] === undefined ? "" : r[x.key])).join(",")));
  return "\uFEFF" + lines.join("\n");
}

function reportXlsx(rep) {
  const rows = [[rep.title]];
  if (rep.note) rows.push([rep.note]);
  rows.push(rep.columns.map((x) => x.en));
  if (rep.columns.some((x) => x.hi)) rows.push(rep.columns.map((x) => x.hi));
  rep.rows.forEach((r) => rows.push(rep.columns.map((x) => (r[x.key] === null || r[x.key] === undefined ? "" : r[x.key]))));
  return writeXlsx([{ name: rep.kind || "Report", rows }]).toString("base64");
}

async function getReportsMeta(ctx) {
  return { status: 200, body: { kinds: KINDS, models: MODELS, denos: DENOS, month: istToday().slice(0, 7), canMonthly: canRunOps(ctx.user), canLoad: canLoad(ctx.user), admin: isAdmin(ctx.user), canExport: can(ctx.user, "Export", "CRM-04") } };
}

async function getReportsViewByKind(ctx) {
  const kind = ctx.params.kind;
  if (!KINDS.includes(kind)) return { status: 404, body: { error: "unknown report" } };
  const month = MONTH_RE.test(String(ctx.query.month)) ? String(ctx.query.month) : istToday().slice(0, 7);
  const atmId = String(ctx.query.atmId || "").trim();
  const f = reportFilters(ctx.query);
  const g = await gather(ctx, month, atmId, f);
  const rep = { kind, month, filters: f, ...buildReport(kind, g, isAdmin(ctx.user)) };
  if (ctx.query.csv || ctx.query.xlsx) {
    if (!can(ctx.user, "Export", "CRM-04")) return { status: 403, body: { error: "Export action not granted" } };
    const fl = filterLabel(f);
    await writeAudit(ctx, "ReportExported", { module: "CRM-04", work: kind + " " + month + (atmId ? " " + atmId : "") + (fl ? " " + fl : "") + " " + rep.rows.length + " rows" + (ctx.query.xlsx ? " xlsx" : "") });
    const base = kind + "-" + month + (atmId ? "-" + atmId : "");
    if (ctx.query.xlsx) return { status: 200, body: { fileName: base + ".xlsx", mime: XLSX_MIME, data: reportXlsx(rep) } };
    return { status: 200, body: { fileName: base + ".csv", csv: reportCsv(rep) } };
  }
  return { status: 200, body: rep };
}

async function getReportsFilters(ctx) {
  const companyId = oid(ctx.user.companyId);
  const atmFilter = { companyId, cashLiveDate: { $ne: null } };
  await applyFranchiseFilter(ctx.user, atmFilter, "franchiseId");
  const atms = await repo.atms.list(atmFilter, { projection: { franchiseId: 1, franchiseeName: 1, salesOfficer: 1, bankName: 1, fundingPath: 1, region: 1 } });
  const uniq = (fn) => [...new Set(atms.map(fn).filter(Boolean))].sort();
  const frIds = [...new Set(atms.map((a) => a.franchiseId && String(a.franchiseId)).filter(Boolean))];
  const frs = frIds.length ? await repo.franchises.list({ _id: { $in: frIds.map(oid) } }, { projection: { name: 1 } }) : [];
  const cras = await repo.ops_cbr1.distinct("cra", { companyId, atmId: { $in: atms.map((a) => a.atmId).filter(Boolean) } });
  return { status: 200, body: {
    franchises: frs.map((x) => ({ id: String(x._id), name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
    salesOfficers: uniq((a) => a.salesOfficer),
    banks: uniq((a) => a.bankName),
    fundingPaths: uniq((a) => a.fundingPath),
    regions: uniq((a) => a.region),
    cras: cras.filter(Boolean).sort(),
  } };
}

async function getReportsMonthly(ctx) {
  const month = MONTH_RE.test(String(ctx.query.month)) ? String(ctx.query.month) : istToday().slice(0, 7);
  const filter = { companyId: oid(ctx.user.companyId), month };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  return { status: 200, body: { month, rows: await repo.ops_monthly.list(filter, { sort: { atmId: 1 } }) } };
}

async function putReportsMonthly(ctx) {
  if (!canRunOps(ctx.user)) return { status: 403, body: { error: "Ops / Admin only" } };
  const r = await saveMonthly(newCtx(ctx), ctx.body, "screen");
  if (r.errors) return { status: 400, body: { error: errText(r.errors) } };
  await writeAudit(ctx, "MonthlySaved", { module: "CRM-04", work: r.key, before: r.before, after: r.set });
  return { status: 200, body: { ok: true } };
}

async function putReportsLoading(ctx) {
  if (!canLoad(ctx.user)) return { status: 403, body: { error: "Ops, Admin or the franchisee only" } };
  const r = await saveLoading(newCtx(ctx), ctx.body, "screen", null);
  if (r.errors) return { status: 400, body: { error: errText(r.errors) } };
  await writeAudit(ctx, "LoadingSaved", { module: "CRM-04", work: r.key, before: r.before, after: r.set });
  return { status: 200, body: { ok: true, lastDayFund: r.set.lastDayFund, wlaClosing: r.set.wlaClosing } };
}

async function patchReportsLoadingByIdCorrect(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "wrong loading calculation is Admin only" } };
  const row = await repo.ops_loading.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const reason = String(ctx.body.reason || "").trim();
  if (!reason) return { status: 400, body: { error: "reason required" } };
  const errors = [];
  const input = loadingInput({ ...row, wlaClosing: null, ...ctx.body }, errors);
  if (errors.length) return { status: 400, body: { error: errText(errors) } };
  const calc = loadingCalc({ ...input, wlaClosingEntered: null });
  if (calc.withdrawalNotesTotal !== input.withdrawal) {
    return { status: 400, body: { error: "withdrawal denominations total " + calc.withdrawalNotesTotal + " must equal the withdrawal amount " + input.withdrawal } };
  }
  const set = { ...input, wlaClosingEntered: calc.wlaClosing, ...calc, adminCorrected: { by: ctx.user._id, at: new Date(), reason }, updatedAt: new Date() };
  await repo.ops_loading.updateById(row._id, { $set: set });
  await carryLoadingForward(row.companyId, row.atmId, row.date);
  const before = {};
  Object.keys(input).forEach((k) => (before[k] = val(row[k])));
  await writeAudit(ctx, "LoadingAdminCorrected", { companyId: row.companyId, module: "CRM-04", recordId: row._id, before, after: set, work: reason });
  return { status: 200, body: { ok: true } };
}

module.exports = { monthEnd, prevMonth, dmy, monthLabel, notesTotal, notesText, sum, last, byDate, diff, val, isFranchiseUser, canLoad, errText, saveMonthly, flatDenos, saveLoading, loadingInput, loadingCalc, previousFund, carryLoadingForward, reportFilters, filterLabel, gather, summarize, c, buildReport, reportCsv, reportXlsx, getReportsMeta, getReportsViewByKind, getReportsFilters, getReportsMonthly, putReportsMonthly, putReportsLoading, patchReportsLoadingByIdCorrect };
