const { isOfficeAdmin, can, isFieldStaff, isFranchiseNetwork } = require("../../middlewares/rbac");
const { IST, COMPLAINT_DONE, TXN_TYPES, TASK_DONE, KINDS } = require("./dashboards.model");
const repo = require("./dashboards.repository");
const { isAdmin } = require("../ops/ops.service");
const { STAGES } = require("../site-projects/site-projects.model");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday, shiftDate, normDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, projectAtmIds } = require("../../utils/scope");
const { lifecycle } = require("../agreements/agreements.model");
const { complaintStats } = require("../report-lists/report-lists.more");
const { priorityLabel } = require("../complaints/complaints.model");
const { sdFullyReceived } = require("../finance/finance.model");

const countBy = (list, fn) => {
  const m = {};
  list.forEach((x) => {
    const k = fn(x) || "—";
    m[k] = (m[k] || 0) + 1;
  });
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, n }));
};

const distinct = (list, fn) => [...new Set(list.map(fn).filter(Boolean))].sort();

const sum = (list, fn) => list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);

function lastDays(n) {
  const today = istToday();
  return Array.from({ length: n }, (_, i) => shiftDate(today, i - n + 1));
}

function lastMonths(n) {
  const [y, m] = istToday().slice(0, 7).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

function series(name, xs, list, xFn, yFn = () => 1) {
  const m = new Map(xs.map((x) => [x, 0]));
  list.forEach((r) => {
    const x = xFn(r);
    if (x && m.has(x)) m.set(x, m.get(x) + (Number(yFn(r)) || 0));
  });
  return { name, points: xs.map((x) => ({ x, y: Math.round(m.get(x) * 100) / 100 })) };
}

function ageBucket(days) {
  if (days <= 1) return "0–1";
  if (days <= 3) return "2–3";
  if (days <= 7) return "4–7";
  if (days <= 15) return "8–15";
  if (days <= 30) return "16–30";
  return "30+";
}

async function scope(ctx) {
  const q = ctx.query;
  const companyId = oid(ctx.user.companyId);
  const probe = {};
  await applyFranchiseFilter(ctx.user, probe, "franchiseId");
  let frIds = probe.franchiseId ? probe.franchiseId.$in.map(String) : null;
  if (q.franchiseId) {
    const node = oid(q.franchiseId);
    const nodes = !node ? [] : await repo.franchises.list({ companyId, $or: [{ _id: node }, { masterId: node }, { superMasterId: node }] }, { projection: { _id: 1 } });
    const sub = nodes.map((n) => String(n._id));
    frIds = frIds ? frIds.filter((id) => sub.includes(id)) : sub;
  }
  const atmFilter = { companyId };
  if (frIds) atmFilter.franchiseId = { $in: frIds.map(oid) };
  if (q.projectId) atmFilter.projectId = oid(q.projectId);
  if (q.atmId) atmFilter.atmId = String(q.atmId);
  if (q.city) atmFilter.city = String(q.city);
  if (q.region) atmFilter.region = String(q.region);
  if (q.client) atmFilter.bankName = String(q.client);
  const scopedIds = await projectAtmIds(ctx.user);
  if (scopedIds) atmFilter.$and = [{ atmId: { $in: scopedIds } }];
  const atms = await repo.atms.list(atmFilter, { projection: { atmId: 1, city: 1, region: 1, bankName: 1, fundingPath: 1, franchiseId: 1, franchiseeName: 1, cashLiveDate: 1, projectId: 1, status: 1 } });
  const narrowed = !!(q.projectId || q.atmId || q.city || q.region || q.client || scopedIds);
  if (narrowed) frIds = [...new Set(atms.map((a) => String(a.franchiseId)).filter((x) => x && x !== "null"))];
  const byAtm = narrowed || frIds ? { atmId: { $in: atms.map((a) => a.atmId) } } : {};
  const byFr = frIds ? { franchiseId: { $in: frIds.map(oid) } } : {};
  return { companyId, frIds, atms, byAtm, byFr, narrowed };
}

// User ids in a named team (users by team / task team, plus linked employees); null when no team is picked.
async function teamSet(companyId, team) {
  if (!team) return null;
  const [users, emps] = await Promise.all([
    repo.collection("users").find({ companyId, $or: [{ team }, { "taskProfile.team": team }] }).project({ _id: 1 }).toArray(),
    repo.collection("employees").find({ companyId, team, userId: { $ne: null } }).project({ userId: 1 }).toArray(),
  ]);
  return new Set([...users.map((u) => String(u._id)), ...emps.map((e) => String(e.userId))]);
}

async function teamNames(companyId) {
  const [lu, docs, empTeams] = await Promise.all([
    repo.collection("lookups").findOne({ companyId }, { projection: { teams: 1 } }),
    repo.collection("teams").find({ companyId }).project({ name: 1 }).toArray(),
    repo.collection("employees").distinct("team", { companyId }),
  ]);
  return [...new Set([...((lu && lu.teams) || []), ...docs.map((d) => d.name), ...empTeams].filter(Boolean))].sort();
}

const period = (q) => (q.from || q.to ? { $gte: new Date((q.from || "2000-01-01") + "T00:00:00+05:30"), $lte: new Date((q.to || istToday()) + "T23:59:59.999+05:30") } : null);

const inPeriod = (range, d) => !!d && new Date(d) >= range.$gte && new Date(d) <= range.$lte;

async function complaintsBoard(ctx, s) {
  const q = ctx.query;
  const now = new Date();
  const filter = { companyId: s.companyId, ...s.byAtm };
  ["state", "ssm", "rm"].forEach((k) => q[k] && (filter[k] = String(q[k])));
  if (q.ownerUserId) filter.ownerUserId = oid(q.ownerUserId);
  if (q.category) filter.category = String(q.category);
  if (q.from || q.to) filter.createdAt = period(q);
  const team = await teamSet(s.companyId, q.team);
  if (team) filter.$or = [{ ownerUserId: { $in: [...team].map(oid) } }, { team: String(q.team) }];
  const rows = await repo.complaints.list(filter, { projection: { history: 0 } });
  const stats = complaintStats(rows, now);
  const deco = rows.map((c) => {
    const open = !COMPLAINT_DONE.includes(c.status);
    const overdue = open && c.dueAt && new Date(c.dueAt) < now;
    const days = Math.floor(((c.closedAt || c.resolvedAt ? new Date(c.closedAt || c.resolvedAt) : now) - new Date(c.createdAt)) / 86400000);
    return { ...c, open, overdue: !!overdue, breach: !!(c.slaBreachedAt || overdue), escalated: (c.escalationLevel || 0) > 0 || c.status === "Escalated", days };
  });
  const st = (x) => deco.filter((c) => c.status === x).length;
  const openRows = deco.filter((c) => c.open);
  const totals = {
    Total: deco.length,
    Open: st("Open") + st("Reopened"),
    Assigned: st("Assigned"),
    "In Progress": deco.filter((c) => ["In Progress", "Pending", "Field Visit Required", "Awaiting Spare", "Awaiting External Action"].includes(c.status)).length,
    Resolved: st("Resolved"),
    Closed: st("Closed"),
    Overdue: deco.filter((c) => c.overdue).length,
    Escalated: deco.filter((c) => c.escalated && c.open).length,
    "SLA breach": deco.filter((c) => c.breach).length,
    "SLA compliance %": stats.slaCompliancePct === "" ? "—" : stats.slaCompliancePct,
    "Avg resolution (h)": stats.avgResolutionHours === "" ? "—" : stats.avgResolutionHours,
  };
  const all = await repo.complaints.list({ companyId: s.companyId, ...s.byAtm }, { projection: { state: 1, city: 1, ssm: 1, rm: 1, ownerUserId: 1, ownerName: 1, category: 1 } });
  const owners = {};
  all.forEach((c) => c.ownerUserId && (owners[String(c.ownerUserId)] = c.ownerName));
  const topCat = countBy(openRows, (c) => c.category)[0];
  const insights = [
    totals.Total + " ticket(s) in view; " + openRows.length + " open, " + totals.Overdue + " overdue, " + totals["SLA breach"] + " with SLA breach.",
    topCat ? "Most open tickets are " + topCat.key + " (" + topCat.n + ")." : "No open tickets.",
    openRows.length ? "Oldest open ticket is " + Math.max(...openRows.map((c) => c.days)) + " day(s) old." : "",
    stats.slaCompliancePct !== "" ? stats.slaCompliancePct + "% of resolved tickets met SLA; average resolution " + stats.avgResolutionHours + " h." : "",
  ].filter(Boolean);
  return {
    totals,
    drill: {
      Open: { kind: "complaints-pending" },
      Assigned: { kind: "complaints-pending" },
      "In Progress": { kind: "complaints-pending" },
      Overdue: { kind: "complaints-sla" },
      "SLA breach": { kind: "complaints-sla" },
      "SLA compliance %": { kind: "complaints-mis" },
      "Avg resolution (h)": { kind: "complaints-mis" },
      "Open by category": { kind: "complaints-category" },
      "Open by age (days)": { kind: "complaints-ageing" },
      "Open by owner": { kind: "complaints-pending" },
      "By state": { kind: "complaints-state" },
      "By status": { kind: "complaints-pending" },
    },
    breakdowns: {
      "Open by category": countBy(openRows, (c) => c.category),
      "Open by age (days)": countBy(openRows, (c) => ageBucket(c.days)),
      "Open by owner": countBy(openRows, (c) => c.ownerName),
      "By state": countBy(deco, (c) => c.state),
      "By status": countBy(deco, (c) => c.status),
    },
    list: deco
      .filter((c) => c.overdue)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .slice(0, 50)
      .map((c) => ({ _link: { page: "service", id: String(c._id) }, docket: c.docketNumber, atmId: c.atmId, franchise: c.franchiseName, category: c.category, priority: priorityLabel(c.priority), status: c.status, owner: c.ownerName, due: c.dueAt, ageDays: c.days })),
    listTitle: "Overdue tickets",
    trends: [
      {
        title: "Tickets raised vs resolved (30 days)",
        type: "line",
        series: [series("Raised", lastDays(30), deco, (c) => istDay(c.createdAt)), series("Resolved", lastDays(30), deco, (c) => (c.resolvedAt || c.closedAt ? istDay(c.resolvedAt || c.closedAt) : ""))],
      },
    ],
    options: {
      state: distinct(all, (c) => c.state),
      city: distinct(s.atms, (a) => a.city),
      region: distinct(s.atms, (a) => a.region),
      ssm: distinct(all, (c) => c.ssm),
      rm: distinct(all, (c) => c.rm),
      category: distinct(all, (c) => c.category),
      owner: Object.entries(owners).map(([id, name]) => ({ id, name })),
    },
    insights,
  };
}

async function projectsBoard(ctx, s) {
  const filter = { companyId: s.companyId };
  if (s.narrowed) filter.atmRef = { $in: s.atms.map((a) => a._id) };
  else Object.assign(filter, s.byFr);
  const rows = await repo.site_projects.list(filter);
  const deco = rows.map((p) => {
    const approved = (p.stages || []).filter((x) => x.approvedAt).length;
    const current = (p.stages || []).find((x) => !x.approvedAt);
    return { ...p, view: p.completedAt ? "Completed" : p.held ? "Held" : "Active", progress: Math.round((approved / STAGES.length) * 100), currentStage: current ? current.name : "Completed" };
  });
  const active = deco.filter((p) => p.view === "Active");
  const month = istToday().slice(0, 7);
  const totals = {
    Total: deco.length,
    Held: deco.filter((p) => p.view === "Held").length,
    Active: active.length,
    Completed: deco.filter((p) => p.view === "Completed").length,
    "Tech Live (not Cash Live)": deco.filter((p) => p.techLiveDate && !p.cashLiveDate).length,
    "Cash Live this month": deco.filter((p) => iso(p.cashLiveDate).startsWith(month)).length,
  };
  const stuck = countBy(active, (p) => p.currentStage)[0];
  const toProjects = { page: "projects" };
  return {
    totals,
    drill: { Total: toProjects, Held: toProjects, Active: toProjects, Completed: toProjects, "Active by current stage": toProjects, "By franchise": toProjects },
    breakdowns: {
      "Active by current stage": countBy(active, (p) => p.currentStage),
      "By franchise": countBy(deco, (p) => p.franchiseName),
    },
    list: deco
      .sort((a, b) => (a.view === b.view ? b.progress - a.progress : a.view.localeCompare(b.view)))
      .slice(0, 100)
      .map((p) => ({ _link: { page: "projects", id: String(p._id) }, site: p.siteLocationName, franchise: p.franchiseName, view: p.view, stage: p.currentStage, progress: p.progress + "%", techLive: iso(p.techLiveDate), cashLive: iso(p.cashLiveDate), heldReason: p.heldReason || "" })),
    listTitle: "Projects (Tech Live / Cash Live dates)",
    trends: [{ title: "Cash Live per month", type: "bar", series: [series("Cash Live", lastMonths(6), deco, (p) => iso(p.cashLiveDate).slice(0, 7))] }],
    insights: [
      totals.Active + " active, " + totals.Held + " held, " + totals.Completed + " completed project(s).",
      stuck ? "Most active projects are at " + stuck.key + " (" + stuck.n + ")." : "",
      totals["Tech Live (not Cash Live)"] ? totals["Tech Live (not Cash Live)"] + " project(s) are Tech Live but not yet Cash Live." : "",
    ].filter(Boolean),
  };
}

async function opsBoard(ctx, s) {
  const date = normDate(ctx.query.date) || normDate(ctx.query.to) || shiftDate(istToday(), -1);
  const month = date.slice(0, 7);
  const live = s.atms.filter((a) => a.cashLiveDate && iso(a.cashLiveDate) <= date);
  const ids = live.map((a) => a.atmId);
  const f = { companyId: s.companyId, atmId: { $in: ids } };
  const [txnDay, cbr1, cbr2, eod, txnMonth, funding] = await Promise.all([
    repo.ops_txn.list({ ...f, date }, { projection: { atmId: 1 } }),
    repo.ops_cbr1.list({ ...f, date }, { projection: { atmId: 1 } }),
    repo.ops_cbr2.list({ ...f, date }, { projection: { atmId: 1 } }),
    repo.ops_eod.list({ ...f, date }, { projection: { atmId: 1, status: 1, openingMismatch: 1, dispenseFlag: 1 } }),
    repo.ops_txn.list({ ...f, date: { $gte: month + "-01", $lte: date } }),
    repo.ops_funding.list({ ...f, date, calcMismatch: true }, { projection: { atmId: 1 } }),
  ]);
  const has = (list) => new Set(list.map((r) => r.atmId));
  const missing = (list) => ids.filter((id) => !has(list).has(id));
  const eodBy = new Map(eod.map((r) => [r.atmId, r]));
  const perAtm = live.map((a) => {
    const liveFrom = iso(a.cashLiveDate) > month + "-01" ? iso(a.cashLiveDate) : month + "-01";
    let days = 0;
    let nonTxn = 0;
    let zero = 0;
    const rows = new Map(txnMonth.filter((r) => r.atmId === a.atmId).map((r) => [r.date, r]));
    for (let d = liveFrom; d <= date; d = shiftDate(d, 1)) {
      days++;
      const r = rows.get(d);
      if (!r) nonTxn++;
      else if (!TXN_TYPES.some((t) => r[t + "Count"])) zero++;
    }
    const e = eodBy.get(a.atmId);
    return { atmId: a.atmId, franchise: a.franchiseeName || "", txn: has(txnDay).has(a.atmId) ? "Yes" : "No", cbr1: has(cbr1).has(a.atmId) ? "Yes" : "No", cbr2: has(cbr2).has(a.atmId) ? "Yes" : "No", eod: e ? e.status : "Missing", nonTxnDays: nonTxn, zeroTxnDays: zero, daysInMonth: days };
  });
  const totals = {
    "Cash Live ATMs": live.length,
    "TXN entered": txnDay.length,
    "CBR 1 entered": has(cbr1).size,
    "CBR 2 entered": has(cbr2).size,
    "EOD missing": missing(eod).length,
    "EOD Draft": eod.filter((e) => e.status === "Draft").length,
    "EOD Submitted": eod.filter((e) => e.status === "Submitted").length,
    "EOD Verified": eod.filter((e) => e.status === "Verified").length,
    "ATMs with Non-TXN days (month)": perAtm.filter((x) => x.nonTxnDays).length,
    "ATMs with Zero TXN days (month)": perAtm.filter((x) => x.zeroTxnDays).length,
  };
  if (isAdmin(ctx.user)) totals["Wrong WLA / indent calc (Admin)"] = funding.length;
  const pct = (n) => (live.length ? Math.round((n / live.length) * 100) : 0);
  const eodDay = { kind: "eod-day", from: date, to: date };
  const txnMonthDrill = { kind: "txn-daily", from: month + "-01", to: date };
  return {
    date,
    totals,
    drill: {
      "TXN entered": txnMonthDrill,
      "EOD missing": eodDay,
      "EOD Draft": eodDay,
      "EOD Submitted": eodDay,
      "EOD Verified": eodDay,
      "EOD status": eodDay,
      "CBR 1 entered": { kind: "cbr-eod", from: date, to: date },
      "CBR 2 entered": { kind: "cbr-eod", from: date, to: date },
      "ATMs with Non-TXN days (month)": txnMonthDrill,
      "ATMs with Zero TXN days (month)": txnMonthDrill,
    },
    breakdowns: {
      "EOD status": countBy(perAtm, (x) => x.eod),
      "Apna ≠ machine dispense": [{ key: "Flagged", n: eod.filter((e) => e.dispenseFlag).length }],
    },
    list: perAtm.sort((a, b) => (a.eod === "Missing" ? -1 : 1) - (b.eod === "Missing" ? -1 : 1) || b.nonTxnDays - a.nonTxnDays),
    listTitle: "Completeness for " + date,
    trends: (() => {
      const days = [];
      for (let d = month + "-01"; d <= date; d = shiftDate(d, 1)) days.push(d);
      const amt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Amount"]) || 0), 0);
      const cnt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Count"]) || 0), 0);
      return [
        { title: "TXN amount per day (₹)", type: "line", series: [series("Amount", days, txnMonth, (r) => r.date, amt)] },
        { title: "TXN count per day", type: "bar", series: [series("Count", days, txnMonth, (r) => r.date, cnt)] },
      ];
    })(),
    insights: [
      "For " + date + ": TXN " + pct(txnDay.length) + "%, CBR 1 " + pct(has(cbr1).size) + "%, EOD submitted or verified " + pct(eod.filter((e) => e.status !== "Draft").length) + "% of " + live.length + " Cash Live ATM(s).",
      totals["ATMs with Non-TXN days (month)"] ? totals["ATMs with Non-TXN days (month)"] + " ATM(s) have days with no TXN entry this month." : "",
    ].filter(Boolean),
  };
}

async function financeBoard(ctx, s) {
  const base = { companyId: s.companyId, ...s.byFr };
  const [sds, payments, gst, payouts, cbs, bs] = await Promise.all([
    repo.security_deposits.list(base),
    repo.payments.list({ ...base, status: { $in: ["Submitted", "Approved"] } }, { projection: { kind: 1, amount: 1, status: 1, franchiseName: 1 } }),
    repo.gst_bills.list({ ...base, status: { $ne: "Completed" } }, { projection: { billNo: 1, franchiseName: 1, month: 1, net: 1, status: 1, pendingAt: 1 } }),
    repo.payouts.list({ ...base, status: { $in: ["Pending", "Approved", "Processing", "On Hold", "Failed"] } }, { projection: { franchiseName: 1, month: 1, amount: 1, status: 1, reason: 1 } }),
    repo.chargebacks.list({ ...base, status: { $in: ["Open", "Under Review"] } }, { projection: { disputeAmount: 1 } }),
    repo.bank_statements.list({ ...base, financeStatus: "Query" }, { projection: { _id: 1 } }),
  ]);
  const pendingSd = sds.filter((x) => !sdFullyReceived(x.status));
  const onHold = payouts.filter((p) => p.status === "On Hold");
  const totals = {
    "Deposits pending": pendingSd.length,
    "Deposit balance ₹": Math.round(sum(pendingSd, (x) => x.balance)),
    "Payments awaiting approval / settlement": payments.length,
    "GST pending at FR": gst.filter((g) => g.pendingAt === "Pending at FR End").length,
    "GST pending at operator": gst.filter((g) => g.pendingAt === "Pending at Hitachi End").length,
    "Payouts on hold": onHold.length,
    "Payouts on hold ₹": Math.round(sum(onHold, (p) => p.amount)),
    "Charge-backs open": cbs.length,
    "Bank statements under query": bs.length,
  };
  const fin = (type) => ({ page: "finance", type });
  return {
    totals,
    drill: {
      "Deposits pending": fin("Security deposit"),
      "Deposit balance ₹": fin("Security deposit"),
      "Payments awaiting approval / settlement": fin("Payments"),
      "GST pending at FR": fin("GST bills"),
      "GST pending at operator": fin("GST bills"),
      "Payouts on hold": fin("Payouts"),
      "Payouts on hold ₹": fin("Payouts"),
      "Charge-backs open": fin("Charge-back"),
      "Bank statements under query": fin("Bank statements"),
      "Deposits by status": fin("Security deposit"),
      "GST bills not completed": fin("GST bills"),
      "Payouts in flight": fin("Payouts"),
    },
    breakdowns: {
      "Deposits by status": countBy(sds, (x) => x.status),
      "GST bills not completed": countBy(gst, (g) => g.pendingAt || g.status),
      "Payouts in flight": countBy(payouts, (p) => p.status),
    },
    list: [
      ...onHold.map((p) => ({ item: "Payout on hold", franchise: p.franchiseName, ref: p.month, amount: p.amount, status: p.status, note: p.reason || "" })),
      ...gst.map((g) => ({ item: "GST bill", franchise: g.franchiseName, ref: g.billNo, amount: g.net, status: g.status, note: g.pendingAt })),
      ...pendingSd.map((x) => ({ item: "Security deposit", franchise: x.franchiseName, ref: x.label, amount: x.balance, status: x.status, note: "" })),
    ],
    listTitle: "Pending finance items",
    trends: await (async () => {
      const months = lastMonths(6);
      const all = await repo.payouts.list({ ...base, month: { $gte: months[0] }, status: { $nin: ["Rejected", "Failed"] } }, { projection: { month: 1, amount: 1, netAmount: 1 } });
      return [{ title: "Payouts per month (₹, net)", type: "bar", series: [series("Net payout", months, all, (p) => p.month, (p) => (p.netAmount === undefined ? p.amount : p.netAmount))] }];
    })(),
    insights: [
      totals["Deposits pending"] + " deposit(s) pending with ₹" + totals["Deposit balance ₹"].toLocaleString("en-IN") + " still to receive.",
      totals["GST pending at FR"] + " GST bill(s) pending at franchisee, " + totals["GST pending at operator"] + " at operator.",
      totals["Payouts on hold"] ? totals["Payouts on hold"] + " payout(s) on hold." : "No payouts on hold.",
    ],
  };
}

async function tasksBoard(ctx, s) {
  const now = new Date();
  const filter = { companyId: s.companyId };
  if (!isOfficeAdmin(ctx.user) && ctx.user.hierarchy !== "Director") filter.$or = [{ assigneeId: ctx.user._id }, { ownerId: ctx.user._id }, { managerId: ctx.user._id }];
  if (s.narrowed) filter.atmId = { $in: s.atms.map((a) => a.atmId) };
  else if (ctx.query.franchiseId && s.frIds) filter.franchiseId = { $in: s.frIds.map(oid) };
  let rows = await repo.tasks.list(filter, { projection: { history: 0, notes: 0 } });
  const team = await teamSet(s.companyId, ctx.query.team);
  if (team) rows = rows.filter((t) => (t.assigneeId && team.has(String(t.assigneeId))) || t.team === ctx.query.team);
  const open = rows.filter((t) => !TASK_DONE.includes(t.status));
  const overdue = open.filter((t) => t.dueAt && new Date(t.dueAt) < now);
  const workload = countBy(open, (t) => t.assigneeName || "Unassigned");
  const range = period(ctx.query);
  const totals = {
    Open: open.length,
    Overdue: overdue.length,
    "Awaiting review": open.filter((t) => ["Submitted for Review", "Under Review"].includes(t.status)).length,
    "On Hold": open.filter((t) => t.status === "On Hold").length,
    Escalated: open.filter((t) => t.escalationLevel > 0).length,
  };
  if (range) {
    totals["Created (period)"] = rows.filter((t) => inPeriod(range, t.createdAt)).length;
    totals["Completed (period)"] = rows.filter((t) => inPeriod(range, t.completedAt)).length;
  } else totals["Completed (7 days)"] = rows.filter((t) => t.completedAt && now - new Date(t.completedAt) < 7 * 86400000).length;
  return {
    totals,
    drill: {
      Open: { kind: "tasks-person" },
      Overdue: { kind: "tasks-overdue" },
      Escalated: { kind: "tasks-overdue" },
      "Awaiting review": { kind: "tasks-person" },
      "Created (period)": { kind: "tasks-person" },
      "Completed (period)": { kind: "tasks-person" },
      "Completed (7 days)": { kind: "tasks-person" },
      "Open by assignee": { kind: "tasks-person" },
      "Open by status": { page: "tasks" },
      "Open by priority": { page: "tasks" },
    },
    breakdowns: { "Open by assignee": workload, "Open by priority": countBy(open, (t) => t.priority), "Open by status": countBy(open, (t) => t.status) },
    list: overdue.map((t) => ({ _link: { page: "tasks", id: String(t._id) }, task: t.taskNo, title: t.title, priority: t.priority, status: t.status, assignee: t.assigneeName, due: t.dueAt, escalation: t.escalationLevel })),
    listTitle: "Overdue tasks",
    trends: [{ title: "Tasks completed per day (14 days)", type: "bar", series: [series("Completed", lastDays(14), rows, (t) => (t.completedAt ? istDay(t.completedAt) : ""))] }],
    insights: [
      open.length + " open task(s), " + overdue.length + " overdue.",
      workload[0] ? "Largest open workload: " + workload[0].key + " (" + workload[0].n + "). Workload is a count of open tasks, not a performance measure." : "",
    ].filter(Boolean),
  };
}

async function overviewBoard(ctx, s) {
  const today = istToday();
  const month = today.slice(0, 7);
  const months = lastMonths(6);
  const ids = s.atms.map((a) => a.atmId);
  const byAtm = { companyId: s.companyId, atmId: { $in: ids } };
  const appFilter = { companyId: s.companyId, ...s.byFr };
  const q = ctx.query;
  const range = period(q);
  const pFrom = range ? q.from || "2000-01-01" : month + "-01";
  const pTo = range ? q.to || today : today;
  const txnFrom = pFrom < months[0] + "-01" ? pFrom : months[0] + "-01";
  const [agreements, inspections, visits, txn, payouts, apps, lu, team] = await Promise.all([
    repo.agreements.list(appFilter, { projection: { status: 1, applicationId: 1, franchiseName: 1, siteLocationName: 1, updatedAt: 1, createdAt: 1, endDate: 1, renewalDate: 1 } }),
    repo.inspections.list({ ...byAtm, date: { $gte: pFrom, $lte: pTo } }, { projection: { status: 1, result: 1, officerName: 1, officerId: 1, date: 1, atmId: 1 } }),
    repo.visits.list({ companyId: s.companyId, ...(s.narrowed || s.frIds ? { atmId: { $in: ids } } : {}), status: { $nin: ["Cancelled"] }, scheduledAt: { $gte: new Date(shiftDate(today, -30) + "T00:00:00+05:30") } }, { projection: { status: 1, officerName: 1, officerId: 1, scheduledAt: 1, checkInAt: 1, atmId: 1 } }),
    repo.ops_txn.list({ ...byAtm, date: { $gte: txnFrom, $lte: today } }),
    repo.payouts.list({ companyId: s.companyId, ...s.byFr, month: { $gte: pFrom.slice(0, 7) < months[0] ? pFrom.slice(0, 7) : months[0] }, status: { $nin: ["Rejected", "Failed"] } }, { projection: { month: 1, amount: 1, netAmount: 1 } }),
    repo.applications.list(appFilter, { projection: { status: 1 } }),
    repo.collection("lookups").findOne({ companyId: s.companyId }),
    teamSet(s.companyId, q.team),
  ]);
  const renewDays = lu && Number(lu.agreementRenewalDays) > 0 ? Number(lu.agreementRenewalDays) : 60;
  const agreementLife = agreements.map((g) => lifecycle(g, agreements, today, renewDays));
  const agreementPending = agreements.filter((a) => a.status !== "Approved");
  const amt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Amount"]) || 0), 0);
  const cnt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Count"]) || 0), 0);
  const txnMonth = txn.filter((r) => r.date >= pFrom && r.date <= pTo);
  const net = (p) => (p.netAmount === undefined ? p.amount : p.netAmount);
  const byTeam = (x) => !team || (x.officerId && team.has(String(x.officerId)));
  const teamInspections = inspections.filter(byTeam);
  const openVisits = visits.filter(byTeam).filter((v) => ["Scheduled", "Rescheduled", "CheckedIn"].includes(v.status));
  const visitsToday = visits.filter(byTeam).filter((v) => istDay(v.scheduledAt) === today);
  const tag = range ? " (period)" : " this month";
  const fieldTeam = {};
  openVisits.forEach((v) => {
    const k = v.officerName || "—";
    fieldTeam[k] = fieldTeam[k] || { officer: k, scheduled: 0, checkedIn: 0, today: 0 };
    if (v.status === "CheckedIn") fieldTeam[k].checkedIn++;
    else fieldTeam[k].scheduled++;
    if (istDay(v.scheduledAt) === today) fieldTeam[k].today++;
  });
  const totals = {
    "Agreements pending": agreementPending.length,
    "Applications in progress": apps.filter((a) => !["Approved", "Rejected"].includes(a.status)).length,
    "Agreements expiring / renewal due": agreementLife.filter((l) => ["Expiring Soon", "Renewal Due"].includes(l)).length,
    ["Inspections" + tag]: teamInspections.length,
    "Inspections failed": teamInspections.filter((i) => i.result === "Fail").length,
    "Field visits today": visitsToday.length,
    "Field officers checked in": Object.values(fieldTeam).filter((x) => x.checkedIn).length,
    "Cash Live ATMs": s.atms.filter((a) => a.cashLiveDate).length,
    ["TXN" + tag]: txnMonth.reduce((x, r) => x + cnt(r), 0),
    ["TXN amount" + tag + " ₹"]: Math.round(txnMonth.reduce((x, r) => x + amt(r), 0)),
    ["Failed TXN" + tag]: txnMonth.reduce((x, r) => x + (Number(r.failedCount) || 0), 0),
    ["Net payouts" + tag + " ₹"]: Math.round(payouts.filter((p) => p.month >= pFrom.slice(0, 7) && p.month <= pTo.slice(0, 7)).reduce((x, p) => x + net(p), 0)),
  };
  const txnDrill = { kind: "txn-daily", from: pFrom, to: pTo };
  return {
    totals,
    drill: {
      "Agreements pending": { kind: "agreements-due" },
      "Agreements expiring / renewal due": { kind: "agreements-due" },
      "Agreement lifecycle": { kind: "agreements-due" },
      "Applications in progress": { page: "applications" },
      ["Inspections" + tag]: { kind: "inspections", from: pFrom, to: pTo },
      "Inspections failed": { kind: "inspections", from: pFrom, to: pTo },
      "Inspections by status": { kind: "inspections", from: pFrom, to: pTo },
      "Field visits today": { kind: "field-performance", from: today, to: today },
      "Open field visits by officer": { kind: "field-performance" },
      ["TXN" + tag]: txnDrill,
      ["TXN amount" + tag + " ₹"]: txnDrill,
      ["Failed TXN" + tag]: txnDrill,
      "ATMs by status": { page: "atms" },
      "Cash Live ATMs": { page: "atms" },
    },
    breakdowns: {
      "ATMs by status": countBy(s.atms, (a) => a.status || "—"),
      "Agreement lifecycle": countBy(agreementLife, (l) => l),
      "Agreements by status": countBy(agreements, (a) => a.status),
      "Inspections by status": countBy(teamInspections, (i) => i.status),
      "Open field visits by officer": countBy(openVisits, (v) => v.officerName),
    },
    list: Object.values(fieldTeam).sort((a, b) => b.today - a.today || b.scheduled - a.scheduled),
    listTitle: "Field team status (open visits)",
    trends: [
      { title: "TXN amount per month (₹)", type: "bar", series: [series("TXN amount", months, txn, (r) => r.date.slice(0, 7), amt)] },
      { title: "Net payouts per month (₹)", type: "line", series: [series("Net payout", months, payouts, (p) => p.month, net)] },
    ],
    insights: [
      totals["Agreements pending"] + " agreement(s) not yet approved; " + totals["Applications in progress"] + " application(s) in progress.",
      totals["Inspections" + tag] + " inspection(s)" + tag + ", " + totals["Inspections failed"] + " failed.",
      totals["Field visits today"] + " field visit(s) scheduled today; " + totals["Field officers checked in"] + " officer(s) currently checked in.",
      "Business" + tag + ": " + totals["TXN" + tag].toLocaleString("en-IN") + " TXN worth ₹" + totals["TXN amount" + tag + " ₹"].toLocaleString("en-IN") + ".",
      totals["Agreements expiring / renewal due"] ? totals["Agreements expiring / renewal due"] + " agreement(s) expiring or due for renewal." : "",
    ].filter(Boolean),
  };
}

async function healthBoard(ctx, s) {
  const { computeHealth, BAND_ORDER, RULES } = require("../report-lists/report-lists.health");
  const h = await computeHealth(s);
  const scored = h.rows.filter((r) => r.score !== "");
  const n = (b) => h.rows.filter((r) => r.band === b).length;
  const risky = h.rows.filter((r) => ["Critical", "At Risk"].includes(r.band));
  const toHealth = { kind: "atm-health" };
  const toAnoms = { kind: "anomalies" };
  return {
    totals: {
      Critical: n("Critical"),
      "At Risk": n("At Risk"),
      Watch: n("Watch"),
      Healthy: n("Healthy"),
      "Not live": n("Not live"),
      "Average score": scored.length ? Math.round(scored.reduce((x, r) => x + r.score, 0) / scored.length) : "—",
      Anomalies: h.anomalies.length,
    },
    drill: { Critical: toHealth, "At Risk": toHealth, Watch: toHealth, Healthy: toHealth, "Not live": toHealth, "Average score": toHealth, Anomalies: toAnoms, "ATMs by health": toHealth, "Anomalies by type": toAnoms, "At risk / critical by region": toHealth },
    breakdowns: {
      "ATMs by health": BAND_ORDER.map((b) => ({ key: b, n: n(b) })).filter((x) => x.n),
      "Anomalies by type": countBy(h.anomalies, (x) => x.type),
      "At risk / critical by region": countBy(risky, (r) => r.region),
    },
    list: risky.map((r) => ({ atmId: r.atmId, franchise: r.franchise, region: r.region, health: r.band, score: r.score, why: r.reasons })),
    listTitle: "ATMs at risk or critical",
    trends: [],
    insights: [
      scored.length + " Cash Live ATM(s) scored: " + BAND_ORDER.filter((b) => n(b)).map((b) => b + " " + n(b)).join(", ") + ".",
      h.anomalies.length ? h.anomalies.length + " anomaly flag(s); open Anomalies for detail." : "No anomalies flagged.",
      "How the score works: " + RULES,
    ],
  };
}

const BUILDERS = { health: healthBoard, overview: overviewBoard, complaints: complaintsBoard, projects: projectsBoard, ops: opsBoard, finance: financeBoard, tasks: tasksBoard };

function boardCsv(kind, b) {
  const lines = [csvCell(kind + " dashboard"), "", "Totals"];
  Object.entries(b.totals).forEach(([k, v]) => lines.push(csvCell(k) + "," + csvCell(v)));
  Object.entries(b.breakdowns).forEach(([title, rows]) => {
    lines.push("", csvCell(title));
    rows.forEach((r) => lines.push(csvCell(r.key) + "," + r.n));
  });
  if (b.list.length) {
    const cols = Object.keys(b.list[0]).filter((c) => !c.startsWith("_"));
    lines.push("", csvCell(b.listTitle), cols.map(csvCell).join(","));
    b.list.forEach((r) => lines.push(cols.map((c) => csvCell(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(",")));
  }
  return "\uFEFF" + lines.join("\n");
}

function canExport(user) {
  return can(user, "Export", "CRM-07") && !isFieldStaff(user);
}

async function getDashboardByKind(ctx) {
  const kind = ctx.params.kind;
  if (!KINDS[kind]) return { status: 404, body: { error: "unknown dashboard" } };
  if (isFieldStaff(ctx.user)) return { status: 403, body: { error: "field staff see their assigned work only" } };
  if (kind === "tasks" && isFranchiseNetwork(ctx.user)) return { status: 403, body: { error: "tasks are for office users only" } };
  if (!can(ctx.user, "View", KINDS[kind])) return { status: 403, body: { error: "not allowed" } };
  const s = await scope(ctx);
  const board = await BUILDERS[kind](ctx, s);
  const projects = await repo.projects.list({ companyId: s.companyId }, { projection: { name: 1 } });
  if (ctx.query.csv) {
    if (!canExport(ctx.user)) return { status: 403, body: { error: "Export action not granted" } };
    await writeAudit(ctx, "ReportExported", { module: "CRM-07", work: "dashboard " + kind + " " + JSON.stringify(ctx.query) });
    return { status: 200, body: { fileName: "dashboard-" + kind + "-" + istToday() + ".csv", csv: boardCsv(kind, board) } };
  }
  const teams = ["finance", "projects", "ops", "health"].includes(kind) ? [] : await teamNames(s.companyId);
  return { status: 200, body: { kind, ...board, projects, teams, canExport: canExport(ctx.user), atmCount: s.atms.length } };
}

module.exports = { countBy, distinct, sum, iso, istDay, lastDays, lastMonths, series, ageBucket, scope, complaintsBoard, projectsBoard, opsBoard, financeBoard, tasksBoard, overviewBoard, BUILDERS, boardCsv, canExport, getDashboardByKind };
