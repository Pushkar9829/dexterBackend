// Scheduled report mail: each user subscribes to report kinds; the sweep mails the file once per period.
const { can } = require("../../middlewares/rbac");
const { LISTS } = require("./report-lists.model");
const repo = require("./report-lists.repository");
const { listAllowed, buildReport, reportFile } = require("./report-lists.service");
const { writeAudit } = require("../../utils/audit-writer");
const { istToday, shiftDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");

const FREQUENCIES = ["daily", "weekly", "monthly"];
const FILTER_KEYS = ["region", "client", "team", "franchiseId"];
const MAX_PER_USER = 20;
const SEND_AFTER_IST_HOUR = 7;
const SYSTEM_REQ = { user: { login: "system" }, headers: {}, ip: "" };

const subs = () => repo.collection("report_subscriptions");

const mailOf = (u) => {
  const e = String((u && (u.email || u.login)) || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
};

// The period a subscription covers when it is sent today: yesterday, last Monday–Sunday, or last month.
function duePeriod(frequency, today) {
  if (frequency === "daily") {
    const d = shiftDate(today, -1);
    return { key: d, query: { from: d, to: d }, label: d };
  }
  if (frequency === "weekly") {
    const dow = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;
    const start = shiftDate(today, -dow - 7);
    return { key: start, query: { from: start, to: shiftDate(start, 6) }, label: "week of " + start };
  }
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const prev = m === 1 ? y - 1 + "-12" : y + "-" + String(m - 1).padStart(2, "0");
  return { key: prev, query: { month: prev }, label: prev };
}

const view = (x) => ({ _id: String(x._id), kind: x.kind, title: (LISTS[x.kind] || {}).title || x.kind, frequency: x.frequency, format: x.format, filters: x.filters || {}, active: x.active !== false, pausedReason: x.pausedReason || "", lastPeriod: x.lastPeriod || "", lastSentAt: x.lastSentAt || null, lastRows: x.lastRows === undefined ? null : x.lastRows, lastError: x.lastError || "" });

async function getReportSubscriptions(ctx) {
  const list = await subs().list({ companyId: oid(ctx.user.companyId), userId: ctx.user._id }, { sort: { createdAt: -1 } });
  return { status: 200, body: { subscriptions: list.map(view), frequencies: FREQUENCIES, email: mailOf(ctx.user) } };
}

async function postReportSubscriptions(ctx) {
  const b = ctx.body || {};
  const kind = String(b.kind || "");
  const def = LISTS[kind];
  if (!def) return { status: 400, body: { error: "unknown report" } };
  if (!listAllowed(ctx.user, def)) return { status: 403, body: { error: "not allowed" } };
  if (!can(ctx.user, "Export", def.module)) return { status: 403, body: { error: "Export action not granted for this report" } };
  if (!mailOf(ctx.user)) return { status: 400, body: { error: "add an email address to your user profile first" } };
  const frequency = String(b.frequency || "");
  if (!FREQUENCIES.includes(frequency)) return { status: 400, body: { error: "frequency must be daily, weekly or monthly" } };
  const format = b.format === "xlsx" ? "xlsx" : "csv";
  const filters = {};
  FILTER_KEYS.forEach((k) => {
    const v = String((b.filters || {})[k] || "").trim();
    if (v) filters[k] = v.slice(0, 120);
  });
  const companyId = oid(ctx.user.companyId);
  if ((await subs().count({ companyId, userId: ctx.user._id })) >= MAX_PER_USER) return { status: 400, body: { error: "at most " + MAX_PER_USER + " subscriptions per user" } };
  if (await subs().findOne({ companyId, userId: ctx.user._id, kind, frequency, filters })) return { status: 409, body: { error: "you already have this subscription" } };
  const now = new Date();
  const doc = { companyId, userId: ctx.user._id, kind, frequency, format, filters, active: true, lastPeriod: duePeriod(frequency, istToday()).key, createdAt: now, updatedAt: now };
  const r = await subs().insert(doc);
  await writeAudit(ctx, "ReportSubscribed", { module: def.module, recordId: r.insertedId, work: def.title + " · " + frequency + " · " + format });
  return { status: 201, body: { subscription: view({ ...doc, _id: r.insertedId }) } };
}

async function deleteReportSubscriptionsById(ctx) {
  const id = oid(ctx.params.id);
  const row = id && (await subs().findOne({ _id: id, companyId: oid(ctx.user.companyId), userId: ctx.user._id }));
  if (!row) return { status: 404, body: { error: "not found" } };
  await subs().deleteById(id);
  await writeAudit(ctx, "ReportUnsubscribed", { module: (LISTS[row.kind] || {}).module || "", recordId: id, work: row.kind + " · " + row.frequency });
  return { status: 200, body: { ok: true } };
}

// Called by the sweep. Rights are re-checked with the user's current record; a user who lost access is paused, not mailed.
async function sweepReportSubscriptions(companyId, now = new Date()) {
  const out = { sent: 0, paused: 0 };
  const istHour = new Date(now.getTime() + 5.5 * 3600000).getUTCHours();
  if (istHour < SEND_AFTER_IST_HOUR) return out;
  const today = istToday();
  const list = await subs().list({ companyId, active: { $ne: false } });
  for (const sub of list) {
    const due = duePeriod(sub.frequency, today);
    if (sub.lastPeriod === due.key) continue;
    const def = LISTS[sub.kind];
    const user = await repo.collection("users").findOne({ _id: sub.userId, companyId });
    const to = mailOf(user);
    const why = !def ? "report no longer exists" : !user || user.active === false ? "user inactive" : !to ? "no email on the user" : !listAllowed(user, def) || !can(user, "Export", def.module) ? "access to this report was removed" : "";
    if (why) {
      await subs().updateById(sub._id, { $set: { active: false, pausedReason: why, updatedAt: now } });
      out.paused++;
      continue;
    }
    const claim = await subs().updateOne({ _id: sub._id, lastPeriod: sub.lastPeriod ?? null }, { $set: { lastPeriod: due.key, updatedAt: now } });
    if (!claim.modifiedCount) continue;
    try {
      const built = await buildReport(user, sub.kind, { ...(sub.filters || {}), ...due.query });
      const file = reportFile(sub.kind, built, sub.format === "xlsx");
      await require("../mail/mail.service").queueMailWithFile(companyId, {
        subject: "Scheduled report: " + built.title,
        body:
          (sub.kind === "management-briefing" ? built.rep.rows.map((r) => r.section + ": " + r.line).join("\n") + "\n\n" : "") +
          "Your " + sub.frequency + " report \"" + def.title + "\" for " + due.label + " is attached (" + built.rep.rows.length + " row(s)).\n\nManage subscriptions on the Report lists page.",
        to: [to],
        file,
      });
      await subs().updateById(sub._id, { $set: { lastSentAt: now, lastRows: built.rep.rows.length, lastError: "" } });
      await writeAudit(SYSTEM_REQ, "ReportEmailed", { companyId, module: def.module, recordId: sub._id, work: built.title + " → " + to + " · " + built.rep.rows.length + " rows" });
      out.sent++;
    } catch (err) {
      await subs().updateById(sub._id, { $set: { lastError: due.label + ": " + String(err.message).slice(0, 300), updatedAt: now } });
    }
  }
  return out;
}

module.exports = { FREQUENCIES, duePeriod, getReportSubscriptions, postReportSubscriptions, deleteReportSubscriptionsById, sweepReportSubscriptions };
