const { notify, companyAdmins, sweepNotices } = require("../modules/notices/notices.service");
const { DONE } = require("../modules/tasks/tasks.model");
const { settings, periodsBetween, historyEntry, createTask } = require("../modules/tasks/tasks.service");
const { writeAudit } = require("../utils/audit-writer");
const { istToday, shiftDate } = require("../utils/dates");
const repo = require("../utils/shared.repository");

const SYSTEM_REQ = { user: { login: "system" }, headers: {}, ip: "" };

async function sweepTemplates(companyId, now) {
  const out = { created: 0, blocked: 0, carried: 0 };
  const { missedPolicy } = await settings(companyId);
  const today = istToday();
  const templates = await repo.task_templates.list({ companyId, status: "Active" });
  for (const tpl of templates) {
    const periods = periodsBetween(null, tpl.lastPeriod, today, tpl);
    for (const p of periods) {
      const dueAt = new Date(new Date(p + "T09:00:00+05:30").getTime() + tpl.dueHours * 3600 * 1000);
      const prev = await repo.tasks.find({ companyId, templateId: tpl._id, status: { $nin: DONE } }).sort({ instancePeriod: -1 }).limit(1).next();
      if (prev && missedPolicy === "Block Next") {
        out.blocked++;
        await repo.task_templates.updateById(tpl._id, { $inc: { blockedCount: 1 }, $push: { skipped: { period: p, reason: "previous instance " + prev.taskNo + " still " + prev.status } } });
      } else if (prev && missedPolicy === "Carry Forward") {
        out.carried++;
        await repo.tasks.updateById(prev._id, { $set: { dueAt, overdueAt: null, escalationLevel: 0, escalatedAt: null, updatedAt: new Date() }, $inc: { carryCount: 1 }, $push: { history: historyEntry(SYSTEM_REQ.user, "Carried forward", { remark: "period " + p + " carried into this task" }) } });
      } else {
        const b = { title: tpl.title + " — " + p, description: tpl.description, type: tpl.type, subType: tpl.subType || "", category: tpl.category, priority: tpl.priority, source: "Recurring", reviewRequired: tpl.reviewRequired, startAt: new Date(p + "T09:00:00+05:30"), dueAt, assigneeId: tpl.assigneeId, assignTeam: tpl.assignTeam, managerId: tpl.managerId };
        let r = await createTask(companyId, { _id: tpl.createdBy, name: "Recurring: " + tpl.title }, b, { templateId: tpl._id, instancePeriod: p, allowPastDue: true });
        if (r.error && (b.assigneeId || b.assignTeam || b.managerId)) {
          r = await createTask(companyId, { _id: tpl.createdBy, name: "Recurring: " + tpl.title }, { ...b, assigneeId: null, assignTeam: null, managerId: null }, { templateId: tpl._id, instancePeriod: p, allowPastDue: true });
          if (r.task) await notify(companyId, await companyAdmins(companyId), { kind: "task", title: "Recurring task unassigned: " + r.task.taskNo, body: "No active assignee or manager for template " + tpl.title, link: { page: "tasks", id: String(r.task._id) } });
        }
        if (r.task) out.created++;
        else if (r.error && !/duplicate|E11000/i.test(String(r.error))) {
          await notify(companyId, await companyAdmins(companyId), { kind: "task", title: "Recurring task not created: " + tpl.title, body: p + " · " + r.error, link: { page: "tasks" }, key: "tpl-fail:" + tpl._id + ":" + p });
        }
      }
      await repo.task_templates.updateById(tpl._id, { $set: { lastPeriod: p, lastRunAt: now } });
    }
    if (tpl.endDate && tpl.endDate < today) {
      await repo.task_templates.updateById(tpl._id, { $set: { status: "Inactive", endedAt: now } });
      await writeAudit(SYSTEM_REQ, "TaskTemplateEnded", { companyId, module: "CRM-06", recordId: tpl._id, work: tpl.title + " reached its end date " + tpl.endDate });
      out.ended = (out.ended || 0) + 1;
    }
  }
  return out;
}

async function sweepReminders(companyId, now) {
  let sent = 0;
  const due = await repo.tasks.list({ companyId, reminders: { $elemMatch: { sentAt: null, at: { $lte: now } } } });
  for (const t of due) {
    for (let i = 0; i < t.reminders.length; i++) {
      const r = t.reminders[i];
      if (r.sentAt || new Date(r.at) > now) continue;
      const u = await repo.tasks.updateOne({ _id: t._id, ["reminders." + i + ".sentAt"]: null }, { $set: { ["reminders." + i + ".sentAt"]: now } });
      if (!u.modifiedCount) continue;
      sent += await notify(companyId, [r.userId], { kind: "reminder", title: "Reminder: " + t.taskNo, body: r.text || t.title, link: { page: "tasks", id: String(t._id) }, key: "task-remind:" + t._id + ":" + i });
    }
  }
  return sent;
}

// Level 1 team lead (falls back to manager), level 2 manager, level 3 senior management (Admin + Director).
async function escalationTarget(companyId, t, level, cfg) {
  const lead = t.team && cfg.teamLeads[t.team] ? cfg.teamLeads[t.team] : null;
  if (level === 1 && lead) return { users: [lead], to: "Team Lead (" + t.team + ")" };
  if (level <= 2 && t.managerId) return { users: [t.managerId], to: "Manager " + (t.managerName || "") };
  if (level <= 2) return { users: await companyAdmins(companyId), to: "Admin (no " + (level === 1 ? "team lead or " : "") + "manager set)" };
  const seniors = await repo.users.list({ companyId, active: true, hierarchy: { $in: ["Director", "Admin"] } }, { projection: { _id: 1 } });
  return { users: seniors.length ? seniors.map((u) => u._id) : await companyAdmins(companyId), to: "Senior Management" };
}

const IST_DAY = (d) => new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

async function sweepTasks(companyId, now) {
  const out = { warned: 0, overdue: 0, escalated: 0, ruleReminders: 0 };
  out.reminders = await sweepReminders(companyId, now);
  const cfg = await settings(companyId);
  const today = istToday();
  const open = await repo.tasks.list({ companyId, status: { $nin: [...DONE, "Pending Approval"] }, dueAt: { $ne: null } });
  for (const t of open) {
    const due = new Date(t.dueAt);
    const link = { page: "tasks", id: String(t._id) };
    const window = Math.max(3600 * 1000, (due - new Date(t.startAt || t.createdAt)) * 0.2);
    const dueDay = IST_DAY(due);
    const who = [t.assigneeId || t.ownerId].filter(Boolean);
    for (const n of cfg.reminderRules.daysBefore || []) {
      if (due > now && who.length && today === shiftDate(dueDay, -n)) {
        out.ruleReminders += await notify(companyId, who, { kind: "reminder", title: "Due in " + n + " day" + (n > 1 ? "s" : "") + ": " + t.taskNo, body: t.title + " · due " + due.toISOString(), link, key: "task-rule:" + t._id + ":" + n + ":" + due.getTime() });
      }
    }
    if (cfg.reminderRules.onDue && who.length && today === dueDay) {
      out.ruleReminders += await notify(companyId, who, { kind: "reminder", title: "Due today: " + t.taskNo, body: t.title + " · due " + due.toISOString(), link, key: "task-rule:" + t._id + ":0:" + due.getTime() });
    }
    if (due > now) {
      if (due - now <= window && t.assigneeId) {
        out.warned += await notify(companyId, [t.assigneeId], { kind: "sla-warning", title: "Task due soon: " + t.taskNo, body: t.title + " · due " + due.toISOString(), link, key: "task-warn:" + t._id + ":" + due.getTime() });
      }
      if (t.overdueAt) await repo.tasks.updateById(t._id, { $set: { overdueAt: null } });
      continue;
    }
    if (!t.overdueAt) {
      const u = await repo.tasks.updateOne({ _id: t._id, overdueAt: null }, { $set: { overdueAt: now }, $push: { history: historyEntry(SYSTEM_REQ.user, "Overdue", { remark: "due " + due.toISOString() }) } });
      if (u.modifiedCount) out.overdue += await notify(companyId, [t.assigneeId, t.ownerId], { kind: "sla-breach", title: "Task overdue: " + t.taskNo, body: t.title, link, key: "task-breach:" + t._id + ":" + due.getTime() });
    }
    const ladder = cfg.escalation[t.priority] || [];
    const level = t.escalationLevel || 0;
    if (level >= 3) continue;
    const hoursLate = (now - due) / 3600000;
    let nextLevel = 0;
    for (let i = level; i < 3; i++) {
      if (ladder[i] === null || ladder[i] === undefined) continue;
      if (hoursLate >= ladder[i]) nextLevel = i + 1;
      break;
    }
    if (!nextLevel) continue;
    const target = { level: nextLevel, ...(await escalationTarget(companyId, t, nextLevel, cfg)) };
    const esc = await repo.tasks.updateOne(
      { _id: t._id, escalationLevel: t.escalationLevel === undefined ? { $in: [0, null] } : level },
      { $set: { escalationLevel: target.level, escalatedAt: now }, $push: { history: historyEntry(SYSTEM_REQ.user, "Escalated", { remark: "level " + target.level + " → " + target.to }) } }
    );
    if (!esc.modifiedCount) continue;
    await notify(companyId, target.users, { kind: "escalation", title: "Escalated (level " + target.level + "): " + t.taskNo, body: t.priority + " task overdue · " + t.title, link, key: "task-esc" + target.level + ":" + t._id + ":" + due.getTime() });
    await writeAudit(SYSTEM_REQ, "Escalated", { companyId, module: "CRM-06", recordId: t._id, work: t.taskNo + " level " + target.level + " → " + target.to });
    out.escalated++;
  }
  return out;
}

async function sweepCompany(companyId) {
  const now = new Date();
  const templates = await sweepTemplates(companyId, now);
  const tasks = await sweepTasks(companyId, now);
  const notices = await sweepNotices(companyId, now);
  const complaints = await require("../modules/complaints/complaints.service").sweepComplaints(companyId, now);
  const automations = await require("./automations").sweepAutomations(companyId);
  const reports = await require("../modules/report-lists/report-lists.subscriptions").sweepReportSubscriptions(companyId, now);
  return { templates, tasks, notices, complaints, automations, reports };
}

const sweepingCompanies = new Set();

async function sweepCompanyLocked(companyId) {
  const key = String(companyId);
  if (sweepingCompanies.has(key)) return null;
  sweepingCompanies.add(key);
  try {
    return await sweepCompany(companyId);
  } finally {
    sweepingCompanies.delete(key);
  }
}

async function sweepAll() {
  const companies = await repo.companies.list({ active: { $ne: false } }, { projection: { _id: 1 } });
  for (const c of companies) {
    try {
      await sweepCompanyLocked(c._id);
    } catch (err) {
      console.error("sweep failed for company " + c._id, err.message);
    }
  }
}

module.exports = { SYSTEM_REQ, sweepTemplates, sweepReminders, sweepTasks, sweepCompany, sweepingCompanies, sweepCompanyLocked, sweepAll };
