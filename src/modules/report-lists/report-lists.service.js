const { can, isFieldStaff, isFranchiseNetwork } = require("../../middlewares/rbac");
const { BUILD_MORE, LISTS_MORE } = require("./report-lists.more");
const { BUILD_HEALTH, LISTS_HEALTH } = require("./report-lists.health");
const { scope } = require("../dashboards/dashboards.service");
const { TXN_TYPES, COMPLAINT_DONE, LISTS, XLSX_MIME } = require("./report-lists.model");
const repo = require("./report-lists.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday, shiftDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { writeXlsx } = require("../../utils/xlsx");

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function period(q) {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
  if (day(q.from) || day(q.to)) {
    const from = day(q.from) || "2000-01-01";
    const to = day(q.to) || istToday();
    return { from, to, label: from + " to " + to };
  }
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.month)) ? String(q.month) : istToday().slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const to = month + "-" + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0");
  return { from: month + "-01", to, label: month, month };
}

const dayRange = (p) => ({ $gte: new Date(p.from + "T00:00:00+05:30"), $lte: new Date(p.to + "T23:59:59+05:30") });

const monthsIn = (p) => ({ $gte: p.from.slice(0, 7), $lte: p.to.slice(0, 7) });

async function teamUserIds(companyId, team) {
  if (!team) return null;
  const [emps, users] = await Promise.all([
    repo.employees.list({ companyId, team, userId: { $ne: null } }, { projection: { userId: 1 } }),
    repo.collection("users").find({ companyId, $or: [{ team }, { "taskProfile.team": team }] }).project({ _id: 1 }).toArray(),
  ]);
  return new Set([...emps.map((e) => String(e.userId)), ...users.map((u) => String(u._id))]);
}

async function txnBy(ctx, keyFn, label) {
  const ids = ctx.s.atms.map((a) => a.atmId);
  const atmBy = new Map(ctx.s.atms.map((a) => [a.atmId, a]));
  const rows = await repo.ops_txn.list({ companyId: ctx.s.companyId, atmId: { $in: ids }, date: { $gte: ctx.p.from, $lte: ctx.p.to } });
  const groups = new Map();
  for (const r of rows) {
    if (ctx.team && !ctx.team.has(String(r.updatedBy))) continue;
    const k = keyFn(atmBy.get(r.atmId) || {}) || "—";
    if (!groups.has(k)) groups.set(k, { group: k, atmSet: new Set(), entries: 0, zeroDays: 0, ...Object.fromEntries(TXN_TYPES.flatMap((t) => [[t + "Count", 0], [t + "Amount", 0]])) });
    const g = groups.get(k);
    g.atmSet.add(r.atmId);
    g.entries++;
    if (!TXN_TYPES.some((t) => r[t + "Count"])) g.zeroDays++;
    TXN_TYPES.forEach((t) => {
      g[t + "Count"] += Number(r[t + "Count"]) || 0;
      g[t + "Amount"] += Number(r[t + "Amount"]) || 0;
    });
  }
  const out = [...groups.values()].map(({ atmSet, ...g }) => ({
    ...g,
    atms: atmSet.size,
    totalCount: TXN_TYPES.reduce((s, t) => s + g[t + "Count"], 0),
    totalAmount: round2(TXN_TYPES.reduce((s, t) => s + g[t + "Amount"], 0)),
  }));
  out.sort((a, b) => b.totalAmount - a.totalAmount);
  return { columns: ["group", "atms", "entries", "zeroDays", ...TXN_TYPES.flatMap((t) => [t + "Count", t + "Amount"]), "totalCount", "totalAmount"], labels: { group: label }, rows: out };
}

const BUILD = {
  "txn-region": (ctx) => txnBy(ctx, (a) => a.region, "Region"),
  "txn-client": (ctx) => txnBy(ctx, (a) => a.bankName, "Client (bank)"),

  async "franchise-consolidated"(ctx) {
    const { s, p } = ctx;
    const byFr = new Map();
    s.atms.forEach((a) => {
      if (!a.franchiseId) return;
      const k = String(a.franchiseId);
      if (!byFr.has(k)) byFr.set(k, []);
      byFr.get(k).push(a.atmId);
    });
    const frIds = [...byFr.keys()].map(oid);
    const base = { companyId: s.companyId, franchiseId: { $in: frIds } };
    const [frs, txn, complaints, payouts, sds, gst, cbs] = await Promise.all([
      repo.franchises.list({ _id: { $in: frIds } }, { projection: { name: 1, layer: 1, status: 1 } }),
      repo.ops_txn.list({ companyId: s.companyId, atmId: { $in: s.atms.map((a) => a.atmId) }, date: { $gte: p.from, $lte: p.to } }),
      repo.complaints.list(base, { projection: { franchiseId: 1, status: 1, createdAt: 1 } }),
      repo.payouts.list({ ...base, month: monthsIn(p), status: { $nin: ["Rejected", "Failed"] } }, { projection: { franchiseId: 1, amount: 1, netAmount: 1 } }),
      repo.security_deposits.list(base, { projection: { franchiseId: 1, balance: 1, status: 1 } }),
      repo.gst_bills.list({ ...base, status: { $ne: "Completed" } }, { projection: { franchiseId: 1 } }),
      repo.chargebacks.list({ ...base, status: { $in: ["Open", "Under Review"] } }, { projection: { franchiseId: 1 } }),
    ]);
    const atmFr = new Map();
    s.atms.forEach((a) => atmFr.set(a.atmId, String(a.franchiseId)));
    const range = dayRange(p);
    const rows = frs.map((f) => {
      const k = String(f._id);
      const mine = (list) => list.filter((x) => String(x.franchiseId) === k);
      const t = txn.filter((r) => atmFr.get(r.atmId) === k);
      const c = mine(complaints);
      return {
        firm: f.name,
        layer: f.layer,
        status: f.status || "",
        atms: byFr.get(k).length,
        txnCount: t.reduce((sum, r) => sum + TXN_TYPES.reduce((x, ty) => x + (Number(r[ty + "Count"]) || 0), 0), 0),
        txnAmount: round2(t.reduce((sum, r) => sum + TXN_TYPES.reduce((x, ty) => x + (Number(r[ty + "Amount"]) || 0), 0), 0)),
        complaintsRaised: c.filter((x) => new Date(x.createdAt) >= range.$gte && new Date(x.createdAt) <= range.$lte).length,
        complaintsOpen: c.filter((x) => !COMPLAINT_DONE.includes(x.status)).length,
        payoutNet: round2(mine(payouts).reduce((sum, x) => sum + (x.netAmount === undefined ? x.amount : x.netAmount), 0)),
        depositBalance: round2(mine(sds).filter((x) => !require("../finance/finance.model").sdFullyReceived(x.status)).reduce((sum, x) => sum + (Number(x.balance) || 0), 0)),
        gstPending: mine(gst).length,
        chargeBacksOpen: mine(cbs).length,
      };
    });
    rows.sort((a, b) => b.txnAmount - a.txnAmount);
    return { columns: ["firm", "layer", "status", "atms", "txnCount", "txnAmount", "complaintsRaised", "complaintsOpen", "payoutNet", "depositBalance", "gstPending", "chargeBacksOpen"], rows };
  },

  async franchises(ctx) {
    const { s } = ctx;
    const filter = { companyId: s.companyId };
    if (s.frIds) filter._id = { $in: s.frIds.map(oid) };
    const frs = await repo.franchises.list(filter, { sort: { name: 1 } });
    const atmsBy = new Map();
    s.atms.forEach((a) => {
      const k = String(a.franchiseId);
      if (!atmsBy.has(k)) atmsBy.set(k, []);
      atmsBy.get(k).push(a);
    });
    const uniq = (list, fn) => [...new Set(list.map(fn).filter(Boolean))].join(", ");
    const rows = frs
      .filter((f) => !s.narrowed || atmsBy.has(String(f._id)))
      .map((f) => {
        const a = atmsBy.get(String(f._id)) || [];
        return { name: f.name, layer: f.layer, status: f.status || "", owner: f.ownerName || "", mobile: f.mobile || "", email: f.email || "", gstin: f.gstin || "", city: f.city || "", state: f.state || "", regions: uniq(a, (x) => x.region), clients: uniq(a, (x) => x.bankName), atms: a.length };
      });
    return { columns: ["name", "layer", "status", "owner", "mobile", "email", "gstin", "city", "state", "regions", "clients", "atms"], rows };
  },

  async "axis-icd"(ctx) {
    const { s } = ctx;
    const ids = s.atms.filter((a) => ["Axis", "ICD"].includes(a.fundingPath)).map((a) => a.atmId);
    const atms = ids.length ? await repo.collection("atms").find({ companyId: s.companyId, atmId: { $in: ids } }).project({ atmId: 1, siteId: 1, fundingPath: 1, email2: 1, city: 1, state: 1, region: 1, bankName: 1, franchiseId: 1, franchiseeName: 1, cashLiveDate: 1, status: 1, salesOfficer: 1, email: 1 }).sort({ atmId: 1 }).toArray() : [];
    const frIds = [...new Set(atms.map((a) => String(a.franchiseId || "")).filter((x) => x && x !== "null"))].map(oid);
    const frs = frIds.length ? await repo.franchises.list({ _id: { $in: frIds } }, { projection: { name: 1, ownerName: 1, mobile: 1, email: 1, masterId: 1, superMasterId: 1 } }) : [];
    const upIds = [...new Set(frs.flatMap((f) => [f.masterId, f.superMasterId]).filter(Boolean).map(String))].map(oid);
    const ups = upIds.length ? await repo.franchises.list({ _id: { $in: upIds } }, { projection: { name: 1, ownerName: 1, mobile: 1, email: 1 } }) : [];
    const frBy = new Map([...frs, ...ups].map((f) => [String(f._id), f]));
    const rows = atms.map((a) => {
      const f = frBy.get(String(a.franchiseId)) || {};
      const m = frBy.get(String(f.masterId || f.superMasterId || "")) || {};
      return { atmId: a.atmId, path: a.fundingPath, siteId: a.siteId || "", salesOfficer: a.salesOfficer || "", city: a.city || "", state: a.state || "", region: a.region || "", client: a.bankName || "", status: a.status || "", cashLive: iso(a.cashLiveDate), franchise: f.name || a.franchiseeName || "", frOwner: f.ownerName || "", frMobile: f.mobile || "", frEmail: f.email || a.email || "", atmEmail2: a.email2 || "", master: m.name || "", masterMobile: m.mobile || "", masterEmail: m.email || "" };
    });
    return { columns: ["atmId", "path", "siteId", "salesOfficer", "city", "state", "region", "client", "status", "cashLive", "franchise", "frOwner", "frMobile", "frEmail", "atmEmail2", "master", "masterMobile", "masterEmail"], labels: { path: "Axis / ICD", atmEmail2: "ATM email 2", master: "Master franchise" }, rows };
  },

  async emails(ctx) {
    const { s, p, team } = ctx;
    const filter = { companyId: s.companyId, createdAt: dayRange(p), status: { $ne: "Draft" } };
    if (s.narrowed || s.frIds) filter.atmId = { $in: s.atms.map((a) => a.atmId) };
    const mails = await repo.mails.list(filter, { projection: { body: 0, attachments: 0 }, sort: { createdAt: -1 }, limit: 5000 });
    let teamTickets = null;
    if (team) {
      const ids = mails.map((m) => m.complaintId).filter(Boolean);
      const t = await repo.complaints.list({ _id: { $in: ids }, team: ctx.q.team }, { projection: { _id: 1 } });
      teamTickets = new Set(t.map((x) => String(x._id)));
    }
    const atmBy = new Map(s.atms.map((a) => [a.atmId, a]));
    const rows = mails
      .filter((m) => !team || team.has(String(m.createdBy)) || (m.complaintId && teamTickets.has(String(m.complaintId))))
      .map((m) => {
        const a = atmBy.get(m.atmId) || {};
        return { date: iso(m.receivedAt || m.sentAt || m.createdAt), way: m.direction === "in" ? "Received" : "Sent", from: m.from || m.createdByName || "", to: (m.to || []).join(", "), subject: m.subject || "", atmId: m.atmId || "", docket: m.docketNumber || "", status: m.status || "", auto: m.auto ? "Yes" : "", region: a.region || "", client: a.bankName || "" };
      });
    return { columns: ["date", "way", "from", "to", "subject", "atmId", "docket", "status", "auto", "region", "client"], rows };
  },

  async inspections(ctx) {
    const { s, p, team } = ctx;
    const filter = { companyId: s.companyId, date: { $gte: p.from, $lte: p.to } };
    if (s.narrowed || s.frIds) filter.atmId = { $in: s.atms.map((a) => a.atmId) };
    const list = await repo.inspections.list(filter, { sort: { date: -1 }, limit: 5000 });
    const atmBy = new Map(s.atms.map((a) => [a.atmId, a]));
    const rows = list
      .filter((x) => !team || team.has(String(x.officerId)))
      .map((x) => {
        const a = atmBy.get(x.atmId) || {};
        const failed = (x.checklist || []).filter(require("../complaints/complaints.model").itemFailed).length;
        return { date: x.date, atmId: x.atmId, type: x.type, officer: x.officerName || "", status: x.status, result: x.result || "", failedItems: failed, region: a.region || "", client: a.bankName || "" };
      });
    return { columns: ["date", "atmId", "type", "officer", "status", "result", "failedItems", "region", "client"], rows };
  },

  async "cbr-eod"(ctx) {
    const { s, p, team } = ctx;
    const to = p.to < shiftDate(p.from, 40) ? p.to : shiftDate(p.from, 40);
    const live = s.atms.filter((a) => a.cashLiveDate && iso(a.cashLiveDate) <= to);
    const f = { companyId: s.companyId, atmId: { $in: live.map((a) => a.atmId) }, date: { $gte: p.from, $lte: to } };
    const [c1, c2, eod] = await Promise.all([
      repo.ops_cbr1.list(f, { projection: { atmId: 1, date: 1, updatedBy: 1 } }),
      repo.ops_cbr2.list(f, { projection: { atmId: 1, date: 1, updatedBy: 1 } }),
      repo.ops_eod.list(f, { projection: { atmId: 1, date: 1, status: 1, updatedBy: 1 } }),
    ]);
    const key = (r) => r.atmId + "|" + r.date;
    const m1 = new Map(c1.map((r) => [key(r), r]));
    const m2 = new Map(c2.map((r) => [key(r), r]));
    const me = new Map(eod.map((r) => [key(r), r]));
    const rows = [];
    for (const a of live) {
      const start = iso(a.cashLiveDate) > p.from ? iso(a.cashLiveDate) : p.from;
      for (let d = start; d <= to; d = shiftDate(d, 1)) {
        const k = a.atmId + "|" + d;
        const hits = [m1.get(k), m2.get(k), me.get(k)].filter(Boolean);
        if (team && !hits.some((r) => team.has(String(r.updatedBy)))) continue;
        const e = me.get(k);
        rows.push({ date: d, atmId: a.atmId, franchise: a.franchiseeName || "", region: a.region || "", client: a.bankName || "", cbr1: m1.has(k) ? "Yes" : "No", cbr2: m2.has(k) ? "Yes" : "No", eod: e ? e.status : "Missing" });
      }
    }
    rows.sort((x, y) => (x.date === y.date ? x.atmId.localeCompare(y.atmId) : y.date.localeCompare(x.date)));
    return { columns: ["date", "atmId", "franchise", "region", "client", "cbr1", "cbr2", "eod"], rows, note: to !== p.to ? "Limited to 41 days from " + p.from : "" };
  },
};

Object.assign(BUILD, BUILD_MORE, BUILD_HEALTH);
Object.assign(LISTS, LISTS_MORE, LISTS_HEALTH);

// Task reports are for office users; franchise logins never see them.
const listAllowed = (user, def) => !isFieldStaff(user) && can(user, "View", def.module) && !(def.module === "CRM-06" && isFranchiseNetwork(user));

function toMatrix(title, rep) {
  const head = rep.columns.map((c) => (rep.labels && rep.labels[c]) || c);
  return [[title], head, ...rep.rows.map((r) => rep.columns.map((c) => (r[c] === null || r[c] === undefined ? "" : r[c])))];
}

async function getReportListsMeta(ctx) {
  const companyId = oid(ctx.user.companyId);
  const s = await scope({ ...ctx, query: {} });
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const empTeams = await repo.employees.distinct("team", { companyId });
  const uniq = (fn) => [...new Set(s.atms.map(fn).filter(Boolean))].sort();
  return { status: 200, body: {
    kinds: Object.entries(LISTS)
      .filter(([, v]) => listAllowed(ctx.user, v))
      .map(([key, v]) => ({ key, title: v.title, module: v.module })),
    regions: uniq((a) => a.region),
    clients: uniq((a) => a.bankName),
    teams: [...new Set([...(lu.teams || []), ...empTeams].filter(Boolean))].sort(),
    month: istToday().slice(0, 7),
  } };
}

// Builds one report for a user and query; shared by the page, exports and scheduled mail.
async function buildReport(user, kind, query) {
  const def = LISTS[kind];
  const s = await scope({ user, query });
  const p = period(query);
  const team = await teamUserIds(s.companyId, String(query.team || "").trim());
  const rep = await BUILD[kind]({ s, p, team, q: query, user });
  const title = def.title + " — " + p.label + ["region", "client", "team"].filter((k) => query[k]).map((k) => " · " + k + " " + query[k]).join("");
  return { def, p, rep, title };
}

function reportFile(kind, built, xlsx) {
  const m = toMatrix(built.title, built.rep);
  const base = kind + "-" + built.p.label.replace(/\s+/g, "");
  if (xlsx) return { name: base + ".xlsx", mime: XLSX_MIME, data: writeXlsx([{ name: built.def.title.slice(0, 31), rows: m }]) };
  return { name: base + ".csv", mime: "text/csv", data: Buffer.from("\uFEFF" + m.map((r) => r.map(csvCell).join(",")).join("\n"), "utf8") };
}

async function getReportListsByKind(ctx) {
  const def = LISTS[ctx.params.kind];
  if (!def) return { status: 404, body: { error: "unknown report" } };
  if (isFieldStaff(ctx.user)) return { status: 403, body: { error: "field staff see their assigned work only" } };
  if (!listAllowed(ctx.user, def)) return { status: 403, body: { error: "not allowed" } };
  const { p, rep, title } = await buildReport(ctx.user, ctx.params.kind, ctx.query);
  if (ctx.query.csv || ctx.query.xlsx) {
    if (!can(ctx.user, "Export", def.module)) return { status: 403, body: { error: "Export action not granted" } };
    await writeAudit(ctx, "ReportExported", { module: def.module, work: title + " " + rep.rows.length + " rows" + (ctx.query.xlsx ? " xlsx" : "") });
    const m = toMatrix(title, rep);
    const base = ctx.params.kind + "-" + p.label.replace(/\s+/g, "");
    if (ctx.query.xlsx) return { status: 200, body: { fileName: base + ".xlsx", mime: XLSX_MIME, data: writeXlsx([{ name: def.title.slice(0, 31), rows: m }]).toString("base64") } };
    return { status: 200, body: { fileName: base + ".csv", csv: "\uFEFF" + m.map((r) => r.map(csvCell).join(",")).join("\n") } };
  }
  return { status: 200, body: { kind: ctx.params.kind, title, ...rep, canExport: can(ctx.user, "Export", def.module) } };
}

module.exports = { iso, round2, period, dayRange, monthsIn, teamUserIds, txnBy, BUILD, toMatrix, listAllowed, buildReport, reportFile, getReportListsMeta, getReportListsByKind };
