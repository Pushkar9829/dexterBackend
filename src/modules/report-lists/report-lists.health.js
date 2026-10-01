// Rule-based analytics: ATM health score, anomaly flags, employee review prompts and a management briefing.
// Every number comes from fixed rules below so a user can see exactly why an ATM or person is flagged.
const repo = require("./report-lists.repository");
const { TXN_TYPES, COMPLAINT_DONE } = require("./report-lists.model");
const { istToday, shiftDate } = require("../../utils/dates");

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const istDay = (d) => new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : "");
const cnt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Count"]) || 0), 0);
const amt = (r) => TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Amount"]) || 0), 0);
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

const DOWN = ["Under Maintenance", "Temporarily Down", "Suspended"];
const BANDS = [
  [80, "Healthy"],
  [60, "Watch"],
  [40, "At Risk"],
  [0, "Critical"],
];
const band = (score) => BANDS.find(([min]) => score >= min)[1];
const BAND_ORDER = ["Critical", "At Risk", "Watch", "Healthy", "Not live"];

// The rule table, shown to users in the report note.
const RULES = "Starts at 100. Down status −40; per day in the last 7 with no TXN entry −4 (max −28), with zero TXN −5 (max −25), with no EOD −3 (max −21); per open ticket −8 (max −24), per open ticket past SLA another −10 (max −20); same fault twice in 30 days −10; per EOD shortage day in 30 days −5 (max −20); last inspection (60 days) failed −15; TXN drop −10. Healthy ≥ 80, Watch 60–79, At Risk 40–59, Critical < 40.";

function liveDays(a, from, to) {
  const start = iso(a.cashLiveDate) > from ? iso(a.cashLiveDate) : from;
  const out = [];
  for (let d = start; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

// Loads the last 35 days of activity for the ATMs in scope and scores each one.
async function computeHealth(s, asOf) {
  const today = asOf || istToday();
  const y = shiftDate(today, -1);
  const d7 = shiftDate(today, -7);
  const d30 = shiftDate(today, -30);
  const d35 = shiftDate(today, -35);
  const ids = s.atms.map((a) => a.atmId);
  const base = { companyId: s.companyId, atmId: { $in: ids } };
  const [txn, eod, complaints, insp] = await Promise.all([
    repo.ops_txn.list({ ...base, date: { $gte: d35, $lte: y } }),
    repo.ops_eod.list({ ...base, date: { $gte: d30, $lte: y } }, { projection: { atmId: 1, date: 1, status: 1, shortage: 1 } }),
    repo.complaints.list({ ...base, $or: [{ status: { $nin: COMPLAINT_DONE } }, { createdAt: { $gte: new Date(d30 + "T00:00:00+05:30") } }] }, { projection: { atmId: 1, problemType: 1, status: 1, dueAt: 1, slaBreachedAt: 1, createdAt: 1, docketNumber: 1 } }),
    repo.inspections.list({ ...base, date: { $gte: shiftDate(today, -60) } }, { projection: { atmId: 1, date: 1, result: 1, status: 1 } }),
  ]);
  const group = (list) => {
    const m = new Map();
    list.forEach((r) => {
      if (!m.has(r.atmId)) m.set(r.atmId, []);
      m.get(r.atmId).push(r);
    });
    return m;
  };
  const txnBy = group(txn);
  const eodBy = group(eod);
  const cBy = group(complaints);
  const iBy = group(insp);
  const now = new Date();
  const rows = [];
  const anomalies = [];
  for (const a of s.atms) {
    const live = !!a.cashLiveDate && iso(a.cashLiveDate) <= y;
    const t = txnBy.get(a.atmId) || [];
    const e = eodBy.get(a.atmId) || [];
    const c = cBy.get(a.atmId) || [];
    const i = (iBy.get(a.atmId) || []).filter((x) => x.result).sort((p, q) => q.date.localeCompare(p.date));
    const open = c.filter((x) => !COMPLAINT_DONE.includes(x.status));
    const breached = open.filter((x) => x.slaBreachedAt || (x.dueAt && new Date(x.dueAt) < now));
    const recent = c.filter((x) => istDay(x.createdAt) >= d30);
    const faults = {};
    recent.forEach((x) => (faults[x.problemType] = (faults[x.problemType] || 0) + 1));
    const repeat = Object.entries(faults).filter(([, n]) => n >= 2);
    const info = { atmId: a.atmId, franchise: a.franchiseeName || "", region: a.region || "", client: a.bankName || "", status: a.status || "", openTickets: open.length, slaBreached: breached.length };
    if (!live) {
      rows.push({ ...info, score: "", band: "Not live", noTxnDays: "", zeroTxnDays: "", noEodDays: "", shortageDays: "", lastInspection: i[0] ? i[0].result : "", txn7: "", reasons: "Not Cash Live yet" });
      continue;
    }
    const days7 = liveDays(a, d7, y);
    const byDay = new Map(t.map((r) => [r.date, r]));
    const noTxn = days7.filter((d) => !byDay.has(d)).length;
    const zero = days7.filter((d) => byDay.has(d) && !cnt(byDay.get(d))).length;
    const eodDays = new Set(e.map((r) => r.date));
    const noEod = days7.filter((d) => !eodDays.has(d)).length;
    const shortDays = e.filter((r) => Number(r.shortage) > 0).length;
    const last7 = t.filter((r) => r.date >= d7);
    const prior = t.filter((r) => r.date < d7);
    const avg7 = days7.length ? last7.reduce((x, r) => x + cnt(r), 0) / days7.length : 0;
    const priorDays = liveDays(a, d35, shiftDate(d7, -1)).length;
    const avgPrior = priorDays ? prior.reduce((x, r) => x + cnt(r), 0) / priorDays : 0;
    const drop = priorDays >= 14 && avgPrior >= 5 && avg7 < avgPrior * 0.5;
    const reasons = [];
    let score = 100;
    const hit = (n, why) => {
      if (n <= 0) return;
      score -= n;
      reasons.push(why + " (−" + n + ")");
    };
    if (DOWN.includes(a.status)) hit(40, "status " + a.status);
    hit(Math.min(28, noTxn * 4), noTxn + " day(s) without TXN entry");
    hit(Math.min(25, zero * 5), zero + " zero-TXN day(s)");
    hit(Math.min(21, noEod * 3), noEod + " day(s) without EOD");
    hit(Math.min(24, open.length * 8), open.length + " open ticket(s)");
    hit(Math.min(20, breached.length * 10), breached.length + " past SLA");
    if (repeat.length) hit(10, "repeat fault: " + repeat.map(([k, n]) => k + " ×" + n).join(", "));
    hit(Math.min(20, shortDays * 5), shortDays + " EOD shortage day(s)");
    if (i[0] && i[0].result === "Fail") hit(15, "last inspection failed " + i[0].date);
    if (drop) hit(10, "TXN down to " + Math.round(avg7) + "/day from " + Math.round(avgPrior));
    score = Math.max(0, score);
    rows.push({ ...info, score, band: band(score), noTxnDays: noTxn, zeroTxnDays: zero, noEodDays: noEod, shortageDays: shortDays, lastInspection: i[0] ? i[0].result : "", txn7: Math.round(avg7), reasons: reasons.join("; ") || "No issues" });
    if (drop) anomalies.push({ atmId: a.atmId, franchise: info.franchise, region: info.region, type: "TXN drop", detail: "last 7 days " + Math.round(avg7) + " TXN/day vs " + Math.round(avgPrior) + " the 28 days before (−" + Math.round((1 - avg7 / avgPrior) * 100) + "%)" });
    if (shortDays >= 3) anomalies.push({ atmId: a.atmId, franchise: info.franchise, region: info.region, type: "Repeated shortage", detail: shortDays + " EOD day(s) with shortage in 30 days, total " + inr(e.reduce((x, r) => x + (Number(r.shortage) || 0), 0)) });
    repeat.forEach(([k, n]) => anomalies.push({ atmId: a.atmId, franchise: info.franchise, region: info.region, type: "Repeat fault", detail: k + " raised " + n + " times in 30 days (" + recent.filter((x) => x.problemType === k).map((x) => x.docketNumber).join(", ") + ")" }));
    if (zero >= 3) anomalies.push({ atmId: a.atmId, franchise: info.franchise, region: info.region, type: "Zero TXN", detail: zero + " zero-TXN day(s) in the last 7" });
  }
  rows.sort((p, q) => BAND_ORDER.indexOf(p.band) - BAND_ORDER.indexOf(q.band) || (p.score === "" ? 1e9 : p.score) - (q.score === "" ? 1e9 : q.score));
  return { rows, anomalies, today, txn, eod, complaints };
}

// Prompts for a manager's attention, never a rating: overdue load, rework, late work and missed / late visits in 30 days.
async function employeeReview(ctx) {
  const today = istToday();
  const since = new Date(shiftDate(today, -30) + "T00:00:00+05:30");
  const now = new Date();
  const [tasks, visits] = await Promise.all([
    repo.collection("tasks").list({ companyId: ctx.s.companyId, $or: [{ status: { $nin: ["Completed", "Closed", "Cancelled"] } }, { completedAt: { $gte: since } }, { "history.at": { $gte: since } }] }, { projection: { assigneeId: 1, assigneeName: 1, team: 1, status: 1, dueAt: 1, completedAt: 1, history: 1 } }),
    repo.collection("visits").list({ companyId: ctx.s.companyId, scheduledAt: { $gte: since, $lte: now } }, { projection: { officerId: 1, officerName: 1, status: 1, scheduledAt: 1, checkInAt: 1 } }),
  ]);
  const people = new Map();
  const person = (id, name) => {
    const k = String(id);
    if (!people.has(k)) people.set(k, { id: k, name: name || "—", team: "", overdue: 0, rework: 0, done: 0, late: 0, visits: 0, lateCheckIn: 0, missed: 0 });
    return people.get(k);
  };
  tasks.forEach((t) => {
    if (!t.assigneeId) return;
    const p = person(t.assigneeId, t.assigneeName);
    if (t.team) p.team = t.team;
    const open = !["Completed", "Closed", "Cancelled"].includes(t.status);
    if (open && t.dueAt && new Date(t.dueAt) < now) p.overdue++;
    p.rework += (t.history || []).filter((h) => h.to === "Rework Required" && new Date(h.at) >= since).length;
    if (t.completedAt && new Date(t.completedAt) >= since && ["Completed", "Closed"].includes(t.status)) {
      p.done++;
      if (t.dueAt && new Date(t.completedAt) > new Date(t.dueAt)) p.late++;
    }
  });
  visits.forEach((v) => {
    if (!v.officerId || v.status === "Cancelled") return;
    const p = person(v.officerId, v.officerName);
    p.visits++;
    if (v.checkInAt && new Date(v.checkInAt) - new Date(v.scheduledAt) > 3600000) p.lateCheckIn++;
    if (!v.checkInAt && ["Scheduled", "Rescheduled"].includes(v.status) && now - new Date(v.scheduledAt) > 86400000) p.missed++;
  });
  let list = [...people.values()];
  if (!require("../tasks/tasks.service").seesAll(ctx.user)) {
    const me = String(ctx.user._id);
    const leads = await require("../teams/teams.service").teamLeadMap(ctx.s.companyId);
    const mine = Object.keys(leads).filter((t) => leads[t] === me);
    list = list.filter((p) => p.id === me || (p.team && mine.includes(p.team)));
  }
  if (ctx.team) list = list.filter((p) => ctx.team.has(p.id) || p.team === ctx.q.team);
  const rows = list
    .map((p) => {
      const why = [];
      if (p.overdue >= 3) why.push(p.overdue + " overdue open tasks");
      if (p.rework >= 2) why.push(p.rework + " rework returns");
      if (p.done >= 4 && p.late / p.done >= 0.5) why.push(p.late + " of " + p.done + " completed late");
      if (p.lateCheckIn >= 3) why.push(p.lateCheckIn + " visit check-ins over 1 h late");
      if (p.missed >= 2) why.push(p.missed + " visits not checked in");
      return { employee: p.name, team: p.team, label: why.length ? "Review Required" : "OK", overdueOpen: p.overdue, rework: p.rework, completed: p.done, completedLate: p.late, visits: p.visits, lateCheckIns: p.lateCheckIn, missedVisits: p.missed, reasons: why.join("; ") };
    })
    .sort((a, b) => (a.label === b.label ? b.overdueOpen - a.overdueOpen : a.label === "Review Required" ? -1 : 1));
  return { columns: ["employee", "team", "label", "overdueOpen", "rework", "completed", "completedLate", "visits", "lateCheckIns", "missedVisits", "reasons"], labels: { label: "Status", overdueOpen: "Overdue open tasks" }, rows, note: "Last 30 days. Review Required when: 3+ overdue open tasks, 2+ rework returns, half or more of 4+ completions late, 3+ check-ins over 1 h late, or 2+ visits not checked in. A prompt for a conversation, not a performance rating." };
}

async function briefingLines(ctx) {
  const yesterday = shiftDate(istToday(), -1);
  const asOf = ctx.p.to < yesterday ? ctx.p.to : yesterday;
  const today = shiftDate(asOf, 1);
  const h = await computeHealth(ctx.s, today);
  const month = asOf.slice(0, 7);
  const [yy, mm] = month.split("-").map(Number);
  const prevMonth = mm === 1 ? yy - 1 + "-12" : yy + "-" + String(mm - 1).padStart(2, "0");
  const dayOfMonth = asOf.slice(8, 10);
  const ids = ctx.s.atms.map((a) => a.atmId);
  const txnMtd = await repo.ops_txn.list({ companyId: ctx.s.companyId, atmId: { $in: ids }, date: { $gte: prevMonth + "-01", $lte: asOf } });
  const sumOf = (list) => ({ n: list.reduce((x, r) => x + cnt(r), 0), amt: list.reduce((x, r) => x + amt(r), 0) });
  const day = sumOf(txnMtd.filter((r) => r.date === asOf));
  const mtd = sumOf(txnMtd.filter((r) => r.date >= month + "-01"));
  const lastMtd = sumOf(txnMtd.filter((r) => r.date >= prevMonth + "-01" && r.date <= prevMonth + "-" + dayOfMonth));
  const live = ctx.s.atms.filter((a) => a.cashLiveDate && iso(a.cashLiveDate) <= asOf);
  const eodDay = h.eod.filter((r) => r.date === asOf);
  const openT = h.complaints.filter((c) => !COMPLAINT_DONE.includes(c.status));
  const now = new Date();
  const monthTickets = await repo.complaints.list({ companyId: ctx.s.companyId, atmId: { $in: ids }, createdAt: { $gte: new Date(month + "-01T00:00:00+05:30"), $lte: new Date(asOf + "T23:59:59.999+05:30") } }, { projection: { resolvedAt: 1, dueAt: 1 } });
  const resolved = monthTickets.filter((c) => c.resolvedAt && c.dueAt);
  const inSla = resolved.filter((c) => new Date(c.resolvedAt) <= new Date(c.dueAt)).length;
  const bands = {};
  h.rows.forEach((r) => (bands[r.band] = (bands[r.band] || 0) + 1));
  const change = lastMtd.n ? Math.round(((mtd.n - lastMtd.n) / lastMtd.n) * 100) : null;
  const lines = [
    ["Business", "TXN on " + asOf + ": " + day.n.toLocaleString("en-IN") + " worth " + inr(day.amt) + "."],
    ["Business", "Month to date: " + mtd.n.toLocaleString("en-IN") + " TXN worth " + inr(mtd.amt) + (change === null ? "." : " (" + (change >= 0 ? "+" : "") + change + "% vs the same days of " + prevMonth + ").")],
    ["Operations", "EOD for " + asOf + ": " + eodDay.filter((r) => r.status !== "Draft").length + " submitted / verified, " + eodDay.filter((r) => r.status === "Draft").length + " draft, " + Math.max(0, live.length - eodDay.length) + " missing of " + live.length + " Cash Live ATM(s)."],
    ["Service", openT.length + " open ticket(s), " + openT.filter((c) => c.slaBreachedAt || (c.dueAt && new Date(c.dueAt) < now)).length + " past SLA. " + monthTickets.length + " raised this month" + (resolved.length ? "; " + pct(inSla, resolved.length) + "% of resolved met SLA." : ".")],
    ["ATM health", BAND_ORDER.filter((b) => bands[b]).map((b) => b + " " + bands[b]).join(", ") + "."],
  ];
  h.rows
    .filter((r) => ["Critical", "At Risk"].includes(r.band))
    .slice(0, 5)
    .forEach((r) => lines.push(["ATM health", r.atmId + " (" + (r.franchise || "no franchise") + ") " + r.band + " " + r.score + ": " + r.reasons]));
  if (h.anomalies.length) {
    const types = {};
    h.anomalies.forEach((x) => (types[x.type] = (types[x.type] || 0) + 1));
    lines.push(["Anomalies", Object.entries(types).map(([k, n]) => k + " " + n).join(", ") + "."]);
    h.anomalies.slice(0, 5).forEach((x) => lines.push(["Anomalies", x.atmId + ": " + x.type + " — " + x.detail]));
  } else lines.push(["Anomalies", "None flagged."]);
  const { can, isFranchiseNetwork } = require("../../middlewares/rbac");
  if (can(ctx.user, "View", "CRM-06") && !isFranchiseNetwork(ctx.user)) {
    const tasks = await repo.collection("tasks").list({ companyId: ctx.s.companyId, status: { $nin: ["Completed", "Closed", "Cancelled"] } }, { projection: { dueAt: 1 } });
    lines.push(["Tasks", tasks.length + " open task(s), " + tasks.filter((t) => t.dueAt && new Date(t.dueAt) < now).length + " overdue (company-wide)."]);
  }
  return { asOf, lines };
}

const BUILD_HEALTH = {
  async "atm-health"(ctx) {
    const h = await computeHealth(ctx.s);
    return { columns: ["atmId", "franchise", "region", "client", "status", "band", "score", "reasons", "noTxnDays", "zeroTxnDays", "noEodDays", "openTickets", "slaBreached", "shortageDays", "lastInspection", "txn7"], labels: { band: "Health", reasons: "Why", noTxnDays: "No TXN entry (7 d)", zeroTxnDays: "Zero TXN (7 d)", noEodDays: "No EOD (7 d)", shortageDays: "Shortage days (30 d)", txn7: "Avg TXN / day (7 d)" }, rows: h.rows, note: "As of " + h.today + " (the month filter does not apply). " + RULES };
  },
  async anomalies(ctx) {
    const h = await computeHealth(ctx.s);
    return { columns: ["atmId", "franchise", "region", "type", "detail"], rows: h.anomalies, note: "As of " + h.today + ". TXN drop: last 7 days below half the previous 28-day average (needs 14+ live days and 5+ TXN/day). Repeated shortage: 3+ EOD shortage days in 30. Repeat fault: same problem type twice in 30 days. Zero TXN: 3+ zero days in the last 7." };
  },
  "employee-review": (ctx) => employeeReview(ctx),
  async "management-briefing"(ctx) {
    const b = await briefingLines(ctx);
    return { columns: ["section", "line"], labels: { line: "Briefing as of " + b.asOf }, rows: b.lines.map(([section, line]) => ({ section, line })), note: "Built from the same rules as the dashboards. Subscribe (✉ Schedule) to get it by mail every morning or week." };
  },
};

const LISTS_HEALTH = {
  "atm-health": { module: "CRM-07", title: "ATM health score" },
  anomalies: { module: "CRM-07", title: "Anomaly flags" },
  "employee-review": { module: "CRM-06", title: "Employee activity: Review Required" },
  "management-briefing": { module: "CRM-07", title: "Management briefing" },
};

module.exports = { RULES, BANDS, BAND_ORDER, computeHealth, employeeReview, briefingLines, BUILD_HEALTH, LISTS_HEALTH };
