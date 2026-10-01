// Phase 4 report kinds: complaints MIS, field performance, tasks, KYC / agreements, mail response, TXN and EOD summaries.
const repo = require("./report-lists.repository");
const { TXN_TYPES, COMPLAINT_DONE } = require("./report-lists.model");
const { lifecycle } = require("../agreements/agreements.model");
const { replyState } = require("../mail/mail.model");
const { PRIORITY_LABELS, priorityLabel } = require("../complaints/complaints.model");
const { istToday, shiftDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { applyRecordScope, applyTicketSet } = require("../../utils/scope");

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b ? round1((a / b) * 100) : "");
const hours = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const avg = (list) => (list.length ? round1(list.reduce((s, x) => s + x, 0) / list.length) : "");
const dayRange = (p) => ({ $gte: new Date(p.from + "T00:00:00+05:30"), $lte: new Date(p.to + "T23:59:59.999+05:30") });
const istDay = (d) => new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
const TASK_DONE = ["Completed", "Closed", "Cancelled"];
const AGE_ORDER = ["0–1", "2–3", "4–7", "8–15", "16–30", "30+"];
const AGE_TOP = [1, 3, 7, 15, 30];
const ageBucket = (days) => AGE_ORDER[AGE_TOP.findIndex((n) => days <= n)] || "30+";

function atmScope(s, key) {
  return s.narrowed || s.frIds ? { [key || "atmId"]: { $in: s.atms.map((a) => a.atmId) } } : {};
}

async function complaintFilter(ctx, extra) {
  const f = { companyId: ctx.s.companyId, ...atmScope(ctx.s), ...(extra || {}) };
  await applyRecordScope(ctx.user, f, ["ownerUserId", "createdBy"], "team");
  applyTicketSet(ctx.user, f);
  if (ctx.team) (f.$and = f.$and || []).push({ $or: [{ ownerUserId: { $in: [...ctx.team].map(oid) } }, { team: ctx.q.team }] });
  return f;
}

const breached = (c, now) => !!(c.slaBreachedAt || (c.dueAt && (c.resolvedAt ? new Date(c.resolvedAt) > new Date(c.dueAt) : !COMPLAINT_DONE.includes(c.status) && now > new Date(c.dueAt))));

function complaintStats(list, now) {
  const resolved = list.filter((c) => c.resolvedAt);
  const withDue = resolved.filter((c) => c.dueAt);
  const inSla = withDue.filter((c) => new Date(c.resolvedAt) <= new Date(c.dueAt)).length;
  return {
    raised: list.length,
    resolved: resolved.length,
    open: list.filter((c) => !COMPLAINT_DONE.includes(c.status)).length,
    slaBreached: list.filter((c) => breached(c, now)).length,
    slaCompliancePct: pct(inSla, withDue.length),
    avgResolutionHours: avg(resolved.map((c) => hours(c.createdAt, c.resolvedAt))),
  };
}

const STAT_COLS = ["raised", "resolved", "open", "slaBreached", "slaCompliancePct", "avgResolutionHours"];
const STAT_LABELS = { slaCompliancePct: "SLA compliance %", avgResolutionHours: "Avg resolution (h)" };

async function complaintGroup(ctx, keyFn, label) {
  const now = new Date();
  const list = await repo.complaints.list(await complaintFilter(ctx, { createdAt: dayRange(ctx.p) }), { projection: { history: 0, attachments: 0 } });
  const groups = new Map();
  for (const c of list) {
    const k = keyFn(c) || "—";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const rows = [...groups.entries()].map(([k, l]) => ({ group: k, ...complaintStats(l, now) })).sort((a, b) => b.raised - a.raised);
  if (rows.length > 1) rows.push({ group: "Total", ...complaintStats(list, now) });
  return { columns: ["group", ...STAT_COLS], labels: { group: label, ...STAT_LABELS }, rows };
}

const TASK_PROJ = { history: 1, assigneeId: 1, assigneeName: 1, team: 1, status: 1, dueAt: 1, completedAt: 1, createdAt: 1, startedAt: 1, reviewRequired: 1, templateId: 1, taskNo: 1, title: 1, priority: 1, escalationLevel: 1, type: 1 };

async function periodTasks(ctx) {
  const range = dayRange(ctx.p);
  const f = { companyId: ctx.s.companyId, $or: [{ createdAt: range }, { completedAt: range }, { status: { $nin: TASK_DONE } }] };
  let list = await repo.collection("tasks").list(f, { projection: { ...TASK_PROJ, ownerId: 1, managerId: 1 } });
  const { seesAll } = require("../tasks/tasks.service");
  if (!seesAll(ctx.user)) {
    const me = String(ctx.user._id);
    const myTeam = ctx.user.taskProfile && ctx.user.taskProfile.team;
    list = list.filter((t) => [t.assigneeId, t.ownerId, t.managerId].some((x) => x && String(x) === me) || (myTeam && t.team === myTeam));
  }
  if (ctx.team) list = list.filter((t) => (t.assigneeId && ctx.team.has(String(t.assigneeId))) || (ctx.q.team && t.team === ctx.q.team));
  return list;
}

function taskStats(list, p, now) {
  const range = dayRange(p);
  const inRange = (d) => d && new Date(d) >= range.$gte && new Date(d) <= range.$lte;
  const done = list.filter((t) => ["Completed", "Closed"].includes(t.status) && inRange(t.completedAt));
  const onTime = done.filter((t) => !t.dueAt || new Date(t.completedAt) <= new Date(t.dueAt)).length;
  const moves = (t, to) => (t.history || []).filter((h) => h.to === to && inRange(h.at)).length;
  return {
    assigned: list.filter((t) => inRange(t.createdAt)).length,
    completed: done.length,
    onTimePct: pct(onTime, done.length),
    slaBreached: done.length - onTime + list.filter((t) => !TASK_DONE.includes(t.status) && t.dueAt && new Date(t.dueAt) < now).length,
    openNow: list.filter((t) => !TASK_DONE.includes(t.status)).length,
    overdueNow: list.filter((t) => !TASK_DONE.includes(t.status) && t.dueAt && new Date(t.dueAt) < now).length,
    reviewed: list.reduce((s, t) => s + moves(t, "Under Review"), 0),
    rework: list.reduce((s, t) => s + moves(t, "Rework Required"), 0),
    avgCompletionHours: avg(done.map((t) => hours(t.startedAt || t.createdAt, t.completedAt))),
  };
}

const TASK_COLS = ["assigned", "completed", "onTimePct", "slaBreached", "openNow", "overdueNow", "reviewed", "rework", "avgCompletionHours"];
const TASK_LABELS = { onTimePct: "On time %", slaBreached: "Late / overdue", avgCompletionHours: "Avg completion (h)" };

function taskGroup(list, keyFn, label, p) {
  const now = new Date();
  const groups = new Map();
  list.forEach((t) => {
    const k = keyFn(t) || "—";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  const rows = [...groups.entries()].map(([k, l]) => ({ group: k, ...taskStats(l, p, now) })).sort((a, b) => b.overdueNow - a.overdueNow || b.openNow - a.openNow);
  if (rows.length > 1) rows.push({ group: "Total", ...taskStats(list, p, now) });
  return { columns: ["group", ...TASK_COLS], labels: { group: label, ...TASK_LABELS }, rows };
}

function txnTotals(rows) {
  const count = rows.reduce((s, r) => s + TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Count"]) || 0), 0), 0);
  const failed = rows.reduce((s, r) => s + (Number(r.failedCount) || 0), 0);
  const out = { atms: new Set(rows.map((r) => r.atmId)).size, entries: rows.length, zeroDays: rows.filter((r) => !TXN_TYPES.some((t) => r[t + "Count"])).length };
  TXN_TYPES.forEach((t) => (out[t + "Count"] = rows.reduce((s, r) => s + (Number(r[t + "Count"]) || 0), 0)));
  return { ...out, totalCount: count, totalAmount: round2(rows.reduce((s, r) => s + TXN_TYPES.reduce((x, t) => x + (Number(r[t + "Amount"]) || 0), 0), 0)), failedCount: failed, failedPct: pct(failed, count + failed) };
}

const TXN_COLS = ["atms", "entries", "zeroDays", ...TXN_TYPES.map((t) => t + "Count"), "totalCount", "totalAmount", "failedCount", "failedPct"];

async function txnRows(ctx, from, to) {
  let rows = await repo.ops_txn.list({ companyId: ctx.s.companyId, atmId: { $in: ctx.s.atms.map((a) => a.atmId) }, date: { $gte: from, $lte: to } });
  if (ctx.team) rows = rows.filter((r) => ctx.team.has(String(r.updatedBy)));
  return rows;
}

function lastMonths(p, n) {
  const end = p.to.slice(0, 7);
  const out = [];
  let [y, m] = end.split("-").map(Number);
  for (let i = 0; i < n; i++) {
    out.unshift(y + "-" + String(m).padStart(2, "0"));
    m -= 1;
    if (!m) (m = 12), (y -= 1);
  }
  return out;
}

const BUILD_MORE = {
  async "complaints-pending"(ctx) {
    const now = new Date();
    const list = await repo.complaints.list(await complaintFilter(ctx, { status: { $nin: COMPLAINT_DONE } }), { projection: { history: 0, attachments: 0 }, sort: { createdAt: 1 }, limit: 5000 });
    const rows = list.map((c) => {
      const age = Math.floor((now - new Date(c.createdAt)) / 86400000);
      return { _link: { page: "service", id: String(c._id) }, docket: c.docketNumber, raised: iso(c.createdAt), ageDays: age, bucket: ageBucket(age), atmId: c.atmId, franchise: c.franchiseName || "", state: c.state || "", problemType: c.problemType, priority: priorityLabel(c.priority), status: c.status, owner: c.ownerName || "", team: c.team || "", due: iso(c.dueAt), slaBreached: breached(c, now) ? "Yes" : "" };
    });
    return { columns: ["docket", "raised", "ageDays", "bucket", "atmId", "franchise", "state", "problemType", "priority", "status", "owner", "team", "due", "slaBreached"], labels: { bucket: "Age (days)" }, rows, note: "All tickets open now (the month filter does not apply)." };
  },

  async "complaints-ageing"(ctx) {
    const now = new Date();
    const list = await repo.complaints.list(await complaintFilter(ctx, { status: { $nin: COMPLAINT_DONE } }), { projection: { createdAt: 1, priority: 1, dueAt: 1, slaBreachedAt: 1, status: 1 } });
    const prios = ["Critical", "High", "Medium", "Low"];
    const rows = AGE_ORDER.map((b) => {
      const inB = list.filter((c) => ageBucket(Math.floor((now - new Date(c.createdAt)) / 86400000)) === b);
      return { bucket: b, ...Object.fromEntries(prios.map((p) => [p, inB.filter((c) => c.priority === p).length])), total: inB.length, slaBreached: inB.filter((c) => breached(c, now)).length };
    });
    rows.push({ bucket: "Total", ...Object.fromEntries(prios.map((p) => [p, list.filter((c) => c.priority === p).length])), total: list.length, slaBreached: list.filter((c) => breached(c, now)).length });
    return { columns: ["bucket", ...prios, "total", "slaBreached"], labels: { bucket: "Age (days)", ...PRIORITY_LABELS }, rows, note: "Open tickets now, by age and priority." };
  },

  async "complaints-sla"(ctx) {
    const now = new Date();
    const list = await repo.complaints.list(await complaintFilter(ctx, { createdAt: dayRange(ctx.p) }), { projection: { history: 0, attachments: 0 }, sort: { createdAt: -1 } });
    const rows = list
      .filter((c) => breached(c, now))
      .map((c) => ({ _link: { page: "service", id: String(c._id) }, docket: c.docketNumber, raised: iso(c.createdAt), atmId: c.atmId, franchise: c.franchiseName || "", category: c.category || "", priority: priorityLabel(c.priority), status: c.status, owner: c.ownerName || "", due: c.dueAt ? new Date(c.dueAt).toISOString().slice(0, 16).replace("T", " ") : "", resolved: c.resolvedAt ? new Date(c.resolvedAt).toISOString().slice(0, 16).replace("T", " ") : "", hoursLate: c.dueAt ? round1(hours(c.dueAt, c.resolvedAt || now)) : "" }));
    return { columns: ["docket", "raised", "atmId", "franchise", "category", "priority", "status", "owner", "due", "resolved", "hoursLate"], labels: { due: "Due (UTC)", resolved: "Resolved (UTC)" }, rows };
  },

  "complaints-state": (ctx) => complaintGroup(ctx, (c) => c.state, "State"),
  "complaints-franchise": (ctx) => complaintGroup(ctx, (c) => c.franchiseName, "Franchisee"),
  "complaints-atm": (ctx) => complaintGroup(ctx, (c) => c.atmId, "ATM"),
  "complaints-category": (ctx) => complaintGroup(ctx, (c) => c.category, "Category"),

  async "complaints-recurring"(ctx) {
    const from = shiftDate(ctx.p.to, -89);
    const list = await repo.complaints.list(await complaintFilter(ctx, { createdAt: dayRange({ from, to: ctx.p.to }) }), { projection: { atmId: 1, problemType: 1, createdAt: 1, status: 1, franchiseName: 1, docketNumber: 1 } });
    const groups = new Map();
    list.forEach((c) => {
      const k = c.atmId + "|" + c.problemType;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    });
    const rows = [...groups.values()]
      .filter((l) => l.length >= 2)
      .map((l) => {
        l.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return { atmId: l[0].atmId, franchise: l[0].franchiseName || "", problemType: l[0].problemType, tickets: l.length, open: l.filter((c) => !COMPLAINT_DONE.includes(c.status)).length, first: iso(l[0].createdAt), last: iso(l[l.length - 1].createdAt), dockets: l.map((c) => c.docketNumber).join(", ") };
      })
      .sort((a, b) => b.tickets - a.tickets);
    return { columns: ["atmId", "franchise", "problemType", "tickets", "open", "first", "last", "dockets"], rows, note: "Same ATM and problem type raised 2+ times in the 90 days up to " + ctx.p.to + "." };
  },

  async "complaints-mis"(ctx) {
    const now = new Date();
    const months = lastMonths(ctx.p, 12);
    const from = months[0] + "-01";
    const list = await repo.complaints.list(await complaintFilter(ctx, { createdAt: dayRange({ from, to: ctx.p.to }) }), { projection: { createdAt: 1, resolvedAt: 1, dueAt: 1, slaBreachedAt: 1, status: 1, channel: 1 } });
    const rows = months.map((m) => {
      const l = list.filter((c) => istDay(c.createdAt).startsWith(m));
      return { month: m, ...complaintStats(l, now), reopened: 0 };
    });
    const reopenList = await repo.complaints.list(await complaintFilter(ctx, { createdAt: dayRange({ from, to: ctx.p.to }), "history.to": "Reopened" }), { projection: { createdAt: 1 } });
    reopenList.forEach((c) => {
      const r = rows.find((x) => istDay(c.createdAt).startsWith(x.month));
      if (r) r.reopened++;
    });
    rows.push({ month: "12 months", ...complaintStats(list, now), reopened: reopenList.length });
    return { columns: ["month", ...STAT_COLS, "reopened"], labels: STAT_LABELS, rows, note: "Tickets by the month they were raised; open = still open today." };
  },

  async "field-performance"(ctx) {
    const range = dayRange(ctx.p);
    const visits = await repo.collection("visits").list({ companyId: ctx.s.companyId, scheduledAt: range, ...atmScope(ctx.s) }, { projection: { officerId: 1, officerName: 1, scheduledAt: 1, checkInAt: 1, checkOutAt: 1, status: 1, outcome: 1 } });
    const insp = await repo.inspections.list({ companyId: ctx.s.companyId, date: { $gte: ctx.p.from, $lte: ctx.p.to }, ...atmScope(ctx.s) }, { projection: { officerId: 1, officerName: 1, status: 1, result: 1 } });
    const by = new Map();
    const row = (id, name) => {
      const k = String(id || "—");
      if (!by.has(k)) by.set(k, { officer: name || "—", id: k, visits: [], insp: [] });
      return by.get(k);
    };
    visits.forEach((v) => row(v.officerId, v.officerName).visits.push(v));
    insp.forEach((x) => row(x.officerId, x.officerName).insp.push(x));
    let rows = [...by.values()];
    if (ctx.team) rows = rows.filter((r) => ctx.team.has(r.id));
    const out = rows.map((r) => {
      const v = r.visits.filter((x) => x.status !== "Cancelled");
      const checked = v.filter((x) => x.checkInAt);
      const onTime = checked.filter((x) => new Date(x.checkInAt) <= new Date(new Date(x.scheduledAt).getTime() + 60 * 60000)).length;
      const submitted = v.filter((x) => x.status === "Submitted");
      return {
        officer: r.officer,
        scheduled: v.length,
        checkedIn: checked.length,
        onTimePct: pct(onTime, checked.length),
        submitted: submitted.length,
        resolvedOnVisit: submitted.filter((x) => x.outcome === "Resolved").length,
        resolutionPct: pct(submitted.filter((x) => x.outcome === "Resolved").length, submitted.length),
        followUps: submitted.filter((x) => x.outcome === "Follow-up visit").length,
        avgOnSiteMins: avg(v.filter((x) => x.checkInAt && x.checkOutAt).map((x) => hours(x.checkInAt, x.checkOutAt) * 60)),
        cancelled: r.visits.length - v.length,
        inspections: r.insp.length,
        inspectionsDone: r.insp.filter((x) => ["Submitted", "Verified"].includes(x.status)).length,
        inspectionsFailed: r.insp.filter((x) => x.result === "Fail").length,
      };
    });
    out.sort((a, b) => b.scheduled - a.scheduled);
    return { columns: ["officer", "scheduled", "checkedIn", "onTimePct", "submitted", "resolvedOnVisit", "resolutionPct", "followUps", "avgOnSiteMins", "cancelled", "inspections", "inspectionsDone", "inspectionsFailed"], labels: { onTimePct: "On-time check-in % (≤1 h)", resolutionPct: "Resolved on visit %", avgOnSiteMins: "Avg on site (min)" }, rows: out };
  },

  async "tasks-person"(ctx) {
    return taskGroup(await periodTasks(ctx), (t) => t.assigneeName || "Unassigned", "Employee", ctx.p);
  },

  async "tasks-team"(ctx) {
    return taskGroup(await periodTasks(ctx), (t) => t.team, "Team", ctx.p);
  },

  async "tasks-overdue"(ctx) {
    const now = new Date();
    const list = (await periodTasks(ctx)).filter((t) => !TASK_DONE.includes(t.status) && t.dueAt && new Date(t.dueAt) < now);
    list.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const rows = list.map((t) => ({ _link: { page: "tasks", id: String(t._id) }, taskNo: t.taskNo, title: t.title, type: t.type || "", priority: t.priority, status: t.status, assignee: t.assigneeName || "Unassigned", team: t.team || "", due: iso(t.dueAt), daysLate: Math.floor((now - new Date(t.dueAt)) / 86400000), escalation: t.escalationLevel || 0 }));
    return { columns: ["taskNo", "title", "type", "priority", "status", "assignee", "team", "due", "daysLate", "escalation"], labels: { escalation: "Escalation level" }, rows, note: "Open tasks past their due date now." };
  },

  async "tasks-recurring"(ctx) {
    const tpls = await repo.collection("task_templates").list({ companyId: ctx.s.companyId }, { projection: { title: 1, frequency: 1, status: 1, assigneeName: 1 } });
    const now = new Date();
    const inst = (await periodTasks(ctx)).filter((i) => i.templateId && tpls.some((t) => String(t._id) === String(i.templateId)) && new Date(i.createdAt) >= dayRange(ctx.p).$gte && new Date(i.createdAt) <= dayRange(ctx.p).$lte);
    const rows = tpls
      .map((t) => {
        const l = inst.filter((i) => String(i.templateId) === String(t._id));
        const done = l.filter((i) => ["Completed", "Closed"].includes(i.status));
        return { template: t.title, frequency: t.frequency, templateStatus: t.status || "", assignee: t.assigneeName || "", generated: l.length, completed: done.length, onTime: done.filter((i) => !i.dueAt || new Date(i.completedAt) <= new Date(i.dueAt)).length, missed: l.filter((i) => !TASK_DONE.includes(i.status) && i.dueAt && new Date(i.dueAt) < now).length, cancelled: l.filter((i) => i.status === "Cancelled").length, completionPct: pct(done.length, l.length) };
      })
      .filter((r) => r.generated || r.templateStatus === "Active");
    return { columns: ["template", "frequency", "templateStatus", "assignee", "generated", "completed", "onTime", "missed", "cancelled", "completionPct"], labels: { completionPct: "Completion %", missed: "Overdue open" }, rows };
  },

  async "kyc-pending"(ctx) {
    const f = { companyId: ctx.s.companyId, $or: [{ parentType: "application" }, { parentType: { $exists: false } }] };
    if (ctx.s.frIds) f.franchiseId = { $in: ctx.s.frIds.map(oid) };
    const docs = await repo.collection("documents").list(f, { projection: { data: 0 } });
    const latest = new Map();
    docs.forEach((d) => {
      const k = String(d.parentId) + "|" + d.type;
      if (!latest.has(k) || (latest.get(k).version || 0) < (d.version || 0)) latest.set(k, d);
    });
    const today = istToday();
    const soon = shiftDate(today, 30);
    const apps = new Map((await repo.collection("applications").list({ companyId: ctx.s.companyId }, { projection: { siteLocationName: 1, applicantName: 1 } })).map((a) => [String(a._id), a]));
    const now = new Date();
    const rows = [...latest.values()]
      .map((d) => {
        const st = d.verificationStatus || "Under Verification";
        const why = st === "Under Verification" ? "Pending verification" : st === "KYC Rejected" ? "Resubmission required" : d.expiry && d.expiry < today ? "Expired" : d.expiry && d.expiry <= soon ? "Expiring ≤30 days" : "";
        const a = apps.get(String(d.parentId)) || {};
        return why ? { _link: d.parentId ? { page: "applications", id: String(d.parentId) } : null, site: a.siteLocationName || "", applicant: a.applicantName || "", document: d.type, version: d.version || 1, state: why, uploaded: iso(d.uploadedAt), waitingDays: d.uploadedAt ? Math.floor((now - new Date(d.uploadedAt)) / 86400000) : "", expiry: d.expiry || "", reason: d.rejectionReason || "" } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (b.waitingDays || 0) - (a.waitingDays || 0));
    return { columns: ["site", "applicant", "document", "version", "state", "uploaded", "waitingDays", "expiry", "reason"], labels: { state: "Why listed" }, rows, note: "Latest version of each document: pending, rejected, expired or expiring within 30 days." };
  },

  async "agreements-due"(ctx) {
    const f = { companyId: ctx.s.companyId };
    if (ctx.s.frIds) f.franchiseId = { $in: ctx.s.frIds.map(oid) };
    const all = await repo.collection("agreements").list(f);
    const lu = (await repo.lookups.findOne({ companyId: ctx.s.companyId })) || {};
    const renewDays = Number(lu.agreementRenewalDays) > 0 ? Number(lu.agreementRenewalDays) : 60;
    const today = istToday();
    const frs = new Map((await repo.franchises.list({ companyId: ctx.s.companyId }, { projection: { name: 1 } })).map((x) => [String(x._id), x.name]));
    const rows = all
      .map((g) => ({ g, life: lifecycle(g, all, today, renewDays) }))
      .filter(({ life }) => ["Draft", "Expiring Soon", "Renewal Due", "Expired"].includes(life))
      .map(({ g, life }) => ({ _link: { page: "legal", id: String(g._id) }, agreementNo: g.agreementNo || "", franchise: frs.get(String(g.franchiseId)) || "", type: g.type || "", status: g.status || "", lifecycle: life, start: g.startDate || "", end: g.endDate || "", daysLeft: g.endDate ? Math.round((new Date(g.endDate + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000) : "", renewalTask: g.renewalTaskNo || "" }))
      .sort((a, b) => (a.daysLeft === "" ? 1e9 : a.daysLeft) - (b.daysLeft === "" ? 1e9 : b.daysLeft));
    return { columns: ["agreementNo", "franchise", "type", "status", "lifecycle", "start", "end", "daysLeft", "renewalTask"], rows, note: "Pending approval (Draft), expiring within 90 days, renewal due or expired." };
  },

  async "email-response"(ctx) {
    const f = { companyId: ctx.s.companyId, createdAt: dayRange(ctx.p), status: { $ne: "Draft" }, ...atmScope(ctx.s) };
    const mails = await repo.mails.list(f, { projection: { direction: 1, status: 1, complaintId: 1, sentAt: 1, receivedAt: 1, createdAt: 1, repliedAt: 1, auto: 1, createdBy: 1 } });
    const outByTicket = new Map();
    mails.filter((m) => m.direction === "out" && m.complaintId && m.sentAt).forEach((m) => {
      const k = String(m.complaintId);
      if (!outByTicket.has(k)) outByTicket.set(k, []);
      outByTicket.get(k).push(new Date(m.sentAt));
    });
    const now = Date.now();
    const days = new Map();
    for (const m of mails) {
      const d = istDay(m.receivedAt || m.sentAt || m.createdAt);
      if (!days.has(d)) days.set(d, { date: d, received: 0, mapped: 0, unmapped: 0, sent: 0, auto: 0, failed: 0, bounced: 0, awaitingReply: 0, noReply: 0, resp: [] });
      const r = days.get(d);
      if (m.direction === "in") {
        r.received++;
        if (m.complaintId) {
          r.mapped++;
          const at = new Date(m.receivedAt || m.createdAt);
          const next = (outByTicket.get(String(m.complaintId)) || []).filter((x) => x > at).sort((a, b) => a - b)[0];
          if (next) r.resp.push(hours(at, next));
        } else r.unmapped++;
      } else {
        if (ctx.team && !ctx.team.has(String(m.createdBy))) continue;
        if (["Sent", "Reply Received"].includes(m.status)) r.sent++;
        if (m.auto) r.auto++;
        if (m.status === "Failed") r.failed++;
        if (m.status === "Bounced") r.bounced++;
        const rs = replyState(m, now);
        if (rs === "Awaiting Reply") r.awaitingReply++;
        if (rs === "No Reply") r.noReply++;
      }
    }
    const rows = [...days.values()].sort((a, b) => b.date.localeCompare(a.date)).map(({ resp, ...r }) => ({ ...r, avgResponseHours: avg(resp), answered: resp.length }));
    return { columns: ["date", "received", "mapped", "unmapped", "answered", "avgResponseHours", "sent", "auto", "failed", "bounced", "awaitingReply", "noReply"], labels: { answered: "Received & answered", avgResponseHours: "Avg first response (h)" }, rows };
  },

  async "txn-daily"(ctx) {
    const rows = await txnRows(ctx, ctx.p.from, ctx.p.to);
    const byDay = new Map();
    rows.forEach((r) => {
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    });
    const out = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, l]) => ({ date: d, ...txnTotals(l) }));
    if (out.length > 1) out.push({ date: "Total", ...txnTotals(rows) });
    return { columns: ["date", ...TXN_COLS], labels: { failedPct: "Failed %", zeroDays: "Zero-TXN ATMs" }, rows: out };
  },

  async "txn-monthly"(ctx) {
    const months = lastMonths(ctx.p, 12);
    const rows = await txnRows(ctx, months[0] + "-01", ctx.p.to);
    const out = months.map((m) => {
      const l = rows.filter((r) => r.date.startsWith(m));
      const t = txnTotals(l);
      const days = new Set(l.map((r) => r.date)).size;
      return { month: m, ...t, avgPerAtmDay: l.length ? Math.round(t.totalCount / l.length) : "", days };
    });
    return { columns: ["month", "days", ...TXN_COLS, "avgPerAtmDay"], labels: { failedPct: "Failed %", zeroDays: "Zero-TXN ATM-days", avgPerAtmDay: "Avg TXN / ATM-day" }, rows: out };
  },

  async "eod-day"(ctx) {
    const to = ctx.p.to < shiftDate(ctx.p.from, 40) ? ctx.p.to : shiftDate(ctx.p.from, 40);
    const eod = await repo.ops_eod.list({ companyId: ctx.s.companyId, atmId: { $in: ctx.s.atms.map((a) => a.atmId) }, date: { $gte: ctx.p.from, $lte: to } }, { projection: { atmId: 1, date: 1, status: 1, updatedBy: 1, openingMismatch: 1, shortage: 1, overage: 1 } });
    const rows = [];
    const today = istToday();
    for (let d = to > today ? today : to; d >= ctx.p.from; d = shiftDate(d, -1)) {
      const live = ctx.s.atms.filter((a) => a.cashLiveDate && iso(a.cashLiveDate) <= d).length;
      let l = eod.filter((e) => e.date === d);
      if (ctx.team) l = l.filter((e) => ctx.team.has(String(e.updatedBy)));
      const c = (st) => l.filter((e) => e.status === st).length;
      rows.push({ date: d, liveAtms: live, draft: c("Draft"), submitted: c("Submitted"), verified: c("Verified"), missing: Math.max(0, live - l.length), openingMismatch: l.filter((e) => e.openingMismatch).length, completionPct: pct(c("Verified") + c("Submitted"), live) });
    }
    return { columns: ["date", "liveAtms", "draft", "submitted", "verified", "missing", "openingMismatch", "completionPct"], labels: { completionPct: "Submitted + verified %" }, rows, note: to !== ctx.p.to ? "Limited to 41 days from " + ctx.p.from : "" };
  },
};

const LISTS_MORE = {
  "complaints-pending": { module: "CRM-05", title: "Complaints: pending" },
  "complaints-ageing": { module: "CRM-05", title: "Complaints: ageing" },
  "complaints-sla": { module: "CRM-05", title: "Complaints: SLA breaches" },
  "complaints-state": { module: "CRM-05", title: "Complaints: state-wise" },
  "complaints-franchise": { module: "CRM-05", title: "Complaints: franchisee-wise" },
  "complaints-atm": { module: "CRM-05", title: "Complaints: ATM-wise" },
  "complaints-category": { module: "CRM-05", title: "Complaints: category-wise" },
  "complaints-recurring": { module: "CRM-05", title: "Complaints: recurring faults" },
  "complaints-mis": { module: "CRM-05", title: "Complaints: monthly MIS" },
  "field-performance": { module: "CRM-05", title: "Sales Officer / field performance" },
  "tasks-person": { module: "CRM-06", title: "Tasks by employee" },
  "tasks-team": { module: "CRM-06", title: "Tasks by team" },
  "tasks-overdue": { module: "CRM-06", title: "Tasks overdue" },
  "tasks-recurring": { module: "CRM-06", title: "Recurring task instances" },
  "kyc-pending": { module: "CRM-02", title: "KYC pending / expiring" },
  "agreements-due": { module: "CRM-02", title: "Agreements pending / expiring" },
  "email-response": { module: "CRM-05", title: "Email response analytics" },
  "txn-daily": { module: "CRM-04", title: "TXN daily summary" },
  "txn-monthly": { module: "CRM-04", title: "TXN monthly summary" },
  "eod-day": { module: "CRM-04", title: "EOD whole-day summary" },
};

module.exports = { BUILD_MORE, LISTS_MORE, complaintStats, breached };
