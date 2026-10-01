const { can, isFieldStaff, isOfficeAdmin, companyScope } = require("../../middlewares/rbac");
const { AppError } = require("../../middlewares/errors");
const { notify, companyAdmins } = require("../notices/notices.service");
const { isAdmin } = require("../ops/ops.service");
const { MISSED_POLICIES, DEFAULT_ESCALATE_AFTER, DEFAULT_ESCALATION, ESCALATION_LEVELS, DEFAULT_REMINDER_RULES, DEFAULT_TASK_TYPES, DONE, REJECTABLE, PRIORITIES, SOURCES, DEFAULT_DUE_HOURS, CATEGORIES, STATUSES, FREQUENCIES, WEEKDAYS, MONTHLY_MODES, TEMPLATE_STATUSES, NEXT, REVIEW_STEPS, occursOn, describeRecurrence } = require("./tasks.model");
const repo = require("./tasks.repository");
const nextVersion = (...args) => require("../documents/documents.service").nextVersion(...args);
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday, shiftDate, normDate } = require("../../utils/dates");
const { storeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

const same = (a, b) => !!a && !!b && String(a) === String(b);

function canCreate(user) {
  if (!can(user, "Create", "CRM-06") || isFieldStaff(user)) return false;
  return isOfficeAdmin(user) || ["Executive", "ServiceProjectOps"].includes(user.functionalRole);
}

function canAssign(user) {
  return canCreate(user) && can(user, "Assign", "CRM-06");
}

function seesAll(user) {
  return isOfficeAdmin(user) || user.hierarchy === "Director";
}

function canSee(user, t) {
  if (!companyScope(user, t.companyId)) return false;
  if (seesAll(user)) return true;
  const team = user.taskProfile && user.taskProfile.team;
  return (
    same(t.assigneeId, user._id) ||
    same(t.ownerId, user._id) ||
    same(t.managerId, user._id) ||
    (!!team && t.team === team) ||
    (t.sharedWith || []).some((id) => same(id, user._id)) ||
    (t.supportIds || []).some((id) => same(id, user._id))
  );
}

const scopeOr = (me, team) => [{ assigneeId: me }, { ownerId: me }, { managerId: me }, { sharedWith: me }, { supportIds: me }, ...(team ? [{ team }] : [])];

function isReviewer(user, t) {
  if (same(t.assigneeId, user._id)) return false;
  return same(t.ownerId, user._id) || same(t.managerId, user._id) || isOfficeAdmin(user);
}

async function settings(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const legacy = { ...DEFAULT_ESCALATE_AFTER, ...(lu.taskEscalateAfterHours || {}) };
  const escalation = {};
  PRIORITIES.forEach((p) => {
    const saved = lu.taskEscalation && lu.taskEscalation[p];
    escalation[p] = Array.isArray(saved) ? saved.slice(0, 3) : [...DEFAULT_ESCALATION[p]];
    if (!Array.isArray(saved) && legacy[p] !== undefined) escalation[p][1] = legacy[p];
  });
  return {
    missedPolicy: lu.taskMissedPolicy || MISSED_POLICIES[0],
    escalateAfterHours: { Critical: escalation.Critical[1], High: escalation.High[1] },
    escalation,
    reminderRules: { ...DEFAULT_REMINDER_RULES, ...(lu.taskReminderRules || {}) },
    taskTypes: Array.isArray(lu.taskTypes) && lu.taskTypes.length ? lu.taskTypes : DEFAULT_TASK_TYPES,
    teamLeads: { ...(lu.taskTeamLeads || {}), ...(await require("../teams/teams.service").teamLeadMap(companyId)) },
    approveStaffTasks: !!lu.taskApproveStaffTasks,
    mailRules: Array.isArray(lu.taskMailRules) ? lu.taskMailRules : [],
    blockCloseWhileTicketOpen: !!lu.taskBlockCloseWhileTicketOpen,
  };
}

const MAIL_RULE_FIELDS = ["subject", "body", "sender"];

// First matching rule turns an inbound mail into a task; returns the task or null.
async function taskFromMailRules(companyId, mail) {
  const cfg = await settings(companyId);
  const text = { subject: String(mail.subject || "").toLowerCase(), body: String(mail.body || "").toLowerCase(), sender: String(mail.from || "").toLowerCase() };
  const rule = cfg.mailRules.find((r) => r.contains && text[r.field] !== undefined && text[r.field].includes(String(r.contains).toLowerCase()));
  if (!rule) return null;
  const actor = { _id: null, name: "Mail rule: " + rule.field + " contains " + rule.contains };
  const b = { title: "Mail: " + (mail.subject || "(no subject)").slice(0, 80), description: "From " + mail.from + "\n\n" + String(mail.body || "").slice(0, 2000), source: "Email", type: rule.type || "Service", priority: rule.priority || "Medium", category: "Office", complaintId: mail.complaintId || undefined, assignTeam: rule.assignTeam || undefined };
  let r = await createTask(companyId, actor, b, { allowPastDue: true });
  if (r.error && b.assignTeam) r = await createTask(companyId, actor, { ...b, assignTeam: undefined }, { allowPastDue: true });
  if (!r.task) return null;
  if (!r.task.assigneeId) await notify(companyId, await companyAdmins(companyId), { kind: "task", title: "Mail task needs an assignee: " + r.task.taskNo, body: mail.from + " — " + String(mail.subject || "").slice(0, 100), link: { page: "tasks", id: String(r.task._id) } });
  return r.task;
}

async function nextTaskNo(companyId) {
  const company = await repo.companies.findById(companyId);
  const d = istToday().slice(2).replace(/-/g, "");
  const r = await repo.counters.findOneAndUpdate({ _id: "task:" + companyId + ":" + d }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  const seq = (r && r.value ? r.value : r).seq;
  return "TSK-" + ((company && company.code) || "CO") + "-" + d + "-" + String(seq).padStart(4, "0");
}

async function inactiveEmployeeUsers(companyId) {
  const list = await repo.employees.list({ companyId, userId: { $ne: null }, employmentStatus: { $ne: "Active" } }, { projection: { userId: 1 } });
  return new Set(list.map((e) => String(e.userId)));
}

async function assignableUsers(companyId) {
  const blocked = await inactiveEmployeeUsers(companyId);
  return (await repo.users.list({ companyId, active: true })).filter((u) => !blocked.has(String(u._id)) && !FRANCHISE_LAYERS.includes(u.hierarchy) && can(u, "View", "CRM-06"));
}

async function openCounts(companyId) {
  const rows = await repo.tasks
    .aggregate([{ $match: { companyId, status: { $nin: DONE }, assigneeId: { $ne: null } } }, { $group: { _id: "$assigneeId", n: { $sum: 1 } } }])
    .toArray();
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function pickAssignee(companyId, spec) {
  const users = await assignableUsers(companyId);
  if (spec.assigneeId) {
    const u = users.find((x) => same(x._id, spec.assigneeId));
    return u ? { user: u, by: "employee" } : { error: "assignee must be an active user of this company with Tasks (CRM-06) access and an active employee record" };
  }
  const by = ["team", "region", "skill"].find((k) => String(spec[k] || "").trim());
  if (!by) return { error: "choose an employee, team, region or skill" };
  const want = String(spec[by]).trim().toLowerCase();
  const pool = users.filter((u) => {
    const p = u.taskProfile || {};
    if (by === "skill") return (p.skills || []).some((s) => String(s).toLowerCase() === want);
    return String(p[by] || "").toLowerCase() === want;
  });
  if (!pool.length) return { error: "no active user with " + by + " " + spec[by] };
  const counts = await openCounts(companyId);
  pool.sort((a, b) => (counts.get(String(a._id)) || 0) - (counts.get(String(b._id)) || 0) || String(a.name).localeCompare(String(b.name)));
  return { user: pool[0], by: by + " " + spec[by] };
}

function historyEntry(user, action, extra) {
  return { at: new Date(), by: user._id || null, byName: user.name || user.login || "system", action, ...extra };
}

function decorate(t, now) {
  const overdue = !DONE.includes(t.status) && t.dueAt && new Date(t.dueAt) < now;
  return { ...t, overdue: !!overdue, displayStatus: overdue ? "Overdue" : t.status };
}

async function resolveRelated(companyId, b) {
  const rel = {};
  if (b.franchiseId) {
    const f = await repo.franchises.findOne({ _id: oid(b.franchiseId), companyId });
    if (!f) return { error: "franchise not in this company" };
    rel.franchiseId = f._id;
    rel.franchiseName = f.name;
  }
  if (b.atmId) {
    const a = await repo.atms.findOne({ companyId, atmId: String(b.atmId).trim() });
    if (!a) return { error: "ATM not in this company" };
    rel.atmId = a.atmId;
    if (!rel.franchiseId && a.franchiseId) rel.franchiseId = a.franchiseId;
  }
  if (b.complaintId) {
    const c = await repo.complaints.findOne({ _id: oid(b.complaintId), companyId });
    if (!c) return { error: "ticket not in this company" };
    rel.complaintId = c._id;
    rel.docketNumber = c.docketNumber;
  }
  if (b.projectId) {
    const p = await repo.site_projects.findOne({ _id: oid(b.projectId), companyId });
    if (!p) return { error: "project not in this company" };
    rel.projectId = p._id;
  }
  return { rel };
}

async function applyAssignment(t, pick, actor, reason) {
  const entry = { at: new Date(), by: actor._id || null, byName: actor.name || actor.login || "system", to: pick.user._id, toName: pick.user.name, via: pick.by, reason: reason || "" };
  const set = { assigneeId: pick.user._id, assigneeName: pick.user.name, team: (pick.user.taskProfile && pick.user.taskProfile.team) || t.team || "", updatedAt: new Date() };
  if (["Created", "Rejected"].includes(t.status)) set.status = "Assigned";
  return { set, entry };
}

async function createTask(companyId, actor, b, extra) {
  const title = String(b.title || "").trim();
  if (!title) return { error: "title required" };
  const priority = PRIORITIES.includes(b.priority) ? b.priority : "Medium";
  const source = b.source || "Manual";
  if (!SOURCES.includes(source)) return { error: "source must be one of " + SOURCES.join(", ") };
  const r = await resolveRelated(companyId, b);
  if (r.error) return { error: r.error };
  let parent = null;
  if (b.parentId) {
    parent = await repo.tasks.findOne({ _id: oid(b.parentId), companyId });
    if (!parent) return { error: "parent task not in this company" };
    if (DONE.includes(parent.status)) return { error: "parent task is " + parent.status };
  }
  const now = new Date();
  const dueAt = b.dueAt ? new Date(b.dueAt) : new Date(now.getTime() + DEFAULT_DUE_HOURS[priority] * 3600 * 1000);
  if (Number.isNaN(dueAt.getTime())) return { error: "bad due date" };
  const startAt = b.startAt ? new Date(b.startAt) : now;
  if (Number.isNaN(startAt.getTime()) || dueAt < startAt) return { error: "due must be after start" };
  if (!extra || !extra.allowPastDue) {
    if (dueAt < now) return { error: "due date is in the past" };
  }
  let manager = null;
  if (b.managerId) {
    manager = await repo.users.findOne({ _id: oid(b.managerId), companyId, active: true });
    if (!manager) return { error: "manager must be an active user of this company" };
  }
  const est = b.estimatedHours === undefined || b.estimatedHours === "" ? null : Number(b.estimatedHours);
  if (est !== null && (!Number.isFinite(est) || est < 0)) return { error: "estimated hours must be ≥ 0" };
  const cfg = await settings(companyId);
  const strict = !!(extra && extra.strictType);
  const typeRow = cfg.taskTypes.find((x) => x.name === b.type) || null;
  if (strict && b.type && !typeRow) return { error: "type must be one of " + cfg.taskTypes.map((x) => x.name).join(", ") };
  let subType = String(b.subType || "").trim();
  if (subType && !(typeRow && (typeRow.subTypes || []).includes(subType))) {
    if (strict) return { error: "sub-type " + subType + " is not listed under " + (b.type || "General") };
    subType = "";
  }
  const blockers = await validBlockers(companyId, null, b.blockedBy);
  if (blockers.error) return { error: blockers.error };
  const reminders = [];
  if (b.reminderAt) {
    const at = new Date(b.reminderAt);
    if (Number.isNaN(at.getTime())) return { error: "reminder date/time is not valid" };
    if (actor._id) reminders.push({ userId: actor._id, at, text: String(b.reminderText || "").trim(), sentAt: null });
  }
  const doc = {
    companyId,
    taskNo: await nextTaskNo(companyId),
    title,
    description: String(b.description || ""),
    type: typeRow ? typeRow.name : b.type && !strict ? String(b.type) : "General",
    subType,
    category: CATEGORIES.includes(b.category) ? b.category : "Office",
    priority,
    status: extra && extra.needsApproval ? "Pending Approval" : "Created",
    source,
    blockedBy: blockers.ids,
    supportIds: [],
    visitLocation: String(b.visitLocation || "").trim().slice(0, 300),
    contactName: String(b.contactName || "").trim().slice(0, 120),
    contactPhone: String(b.contactPhone || "").trim().slice(0, 20),
    parentId: parent ? parent._id : null,
    assigneeId: null,
    assigneeName: "",
    team: String(b.team || "").trim(),
    ownerId: actor._id || null,
    ownerName: actor.name || actor.login || "system",
    managerId: manager ? manager._id : null,
    managerName: manager ? manager.name : "",
    ...r.rel,
    reviewRequired: b.reviewRequired !== false && b.reviewRequired !== "false",
    startAt,
    dueAt,
    estimatedHours: est,
    actualHours: null,
    percent: 0,
    escalationLevel: 0,
    notes: [],
    history: [historyEntry(actor, "Created", { to: extra && extra.needsApproval ? "Pending Approval" : "Created" })],
    assignments: [],
    reminders,
    templateId: (extra && extra.templateId) || null,
    instancePeriod: (extra && extra.instancePeriod) || null,
    createdAt: now,
    updatedAt: now,
  };
  const spec = { assigneeId: b.assigneeId, team: b.assignTeam, region: b.assignRegion, skill: b.assignSkill };
  let pick = null;
  if ((spec.assigneeId || spec.team || spec.region || spec.skill) && doc.status !== "Pending Approval") {
    pick = await pickAssignee(companyId, spec);
    if (pick.error) return { error: pick.error };
    const a = await applyAssignment(doc, pick, actor, "");
    Object.assign(doc, a.set);
    doc.assignments.push(a.entry);
    doc.history.push(historyEntry(actor, "Assigned", { from: "Created", to: "Assigned", remark: pick.user.name + " (" + pick.by + ")" }));
  }
  try {
    const ins = await repo.tasks.insert(doc);
    doc._id = ins.insertedId;
  } catch (err) {
    if (err && err.code === 11000) return { duplicate: true };
    throw err;
  }
  if (pick) {
    await notify(companyId, [pick.user._id], { kind: "assignment", title: "Task assigned: " + doc.taskNo, body: doc.title + " · due " + doc.dueAt.toISOString(), link: { page: "tasks", id: String(doc._id) } });
  }
  if (doc.status === "Pending Approval") {
    const approvers = doc.managerId ? [doc.managerId] : await companyAdmins(companyId);
    await notify(companyId, approvers, { kind: "task", title: "Task needs approval: " + doc.taskNo, body: doc.title + " · by " + doc.ownerName, link: { page: "tasks", id: String(doc._id) } });
  }
  return { task: doc, pick };
}

// When an employee leaves or is suspended, their open tasks go to the task manager (else owner); leftovers are flagged to Admin.
async function reassignFromInactive(ctx, companyId, userId, why) {
  const open = await repo.tasks.list({ companyId, assigneeId: userId, status: { $nin: DONE } }, { projection: { taskNo: 1, title: 1, status: 1, managerId: 1, ownerId: 1 } });
  if (!open.length) return { moved: 0, left: 0 };
  const pool = new Map((await assignableUsers(companyId)).map((u) => [String(u._id), u]));
  let moved = 0;
  const left = [];
  for (const t of open) {
    const to = [t.managerId, t.ownerId].map((x) => x && pool.get(String(x))).find((u) => u && !same(u._id, userId));
    if (!to) {
      left.push(t.taskNo);
      continue;
    }
    const status = ["Created", "Rejected", "Pending Approval"].includes(t.status) ? t.status : "Assigned";
    const u = await repo.tasks.updateOne(
      { _id: t._id, assigneeId: userId },
      {
        $set: { assigneeId: to._id, assigneeName: to.name, status, updatedAt: new Date() },
        $push: {
          assignments: { at: new Date(), by: ctx.user._id || null, byName: ctx.user.name || ctx.user.login || "system", to: to._id, toName: to.name, via: "employee inactive", reason: why },
          history: historyEntry(ctx.user, "Reassigned", { from: t.status, to: status, remark: "previous assignee " + why + " → " + to.name }),
        },
      }
    );
    if (!u.modifiedCount) continue;
    moved++;
    await notify(companyId, [to._id], { kind: "assignment", title: "Task reassigned to you: " + t.taskNo, body: t.title + " · previous assignee " + why, link: { page: "tasks", id: String(t._id) } });
  }
  if (left.length) await notify(companyId, await companyAdmins(companyId), { kind: "task", title: left.length + " task(s) need a new assignee", body: "Assignee " + why + " and no active manager/owner: " + left.slice(0, 10).join(", "), link: { page: "tasks" } });
  await writeAudit(ctx, "TasksReassigned", { companyId, module: "CRM-06", recordId: userId, work: moved + " moved, " + left.length + " left (" + why + ")" });
  return { moved, left: left.length };
}

// Blockers must be open-or-done tasks of the same company; self and cycles are refused.
async function validBlockers(companyId, selfId, raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map(String))].map(oid).filter(Boolean);
  if (!ids.length) return { ids: [] };
  if (ids.length > 20) return { error: "at most 20 blocking tasks" };
  if (selfId && ids.some((x) => same(x, selfId))) return { error: "a task cannot block itself" };
  const found = await repo.tasks.list({ _id: { $in: ids }, companyId }, { projection: { blockedBy: 1, taskNo: 1 } });
  if (found.length !== ids.length) return { error: "blocking tasks must be tasks of this company" };
  if (selfId) {
    const seen = new Set();
    let frontier = found;
    for (let depth = 0; depth < 20 && frontier.length; depth++) {
      const next = [];
      for (const f of frontier) {
        for (const b of f.blockedBy || []) {
          if (same(b, selfId)) return { error: f.taskNo + " already waits on this task (circular dependency)" };
          if (!seen.has(String(b))) {
            seen.add(String(b));
            next.push(b);
          }
        }
      }
      frontier = next.length ? await repo.tasks.list({ _id: { $in: next } }, { projection: { blockedBy: 1, taskNo: 1 } }) : [];
    }
  }
  return { ids };
}

async function typeRule(t) {
  return (await settings(t.companyId)).taskTypes.find((x) => x.name === t.type) || {};
}

// What the task type still needs before completion: labelled files and a field check-in/out.
async function evidenceMissing(t) {
  const rule = await typeRule(t);
  const need = [];
  if ((rule.evidence || []).length) {
    const have = new Set((await repo.documents.list({ parentType: "task", parentId: t._id }, { projection: { type: 1 } })).map((d) => String(d.type).toLowerCase()));
    const missing = rule.evidence.filter((e) => !have.has(e.toLowerCase()));
    if (missing.length) need.push("attach " + missing.join(", "));
  }
  if (rule.gps && !(t.checkInAt && t.checkOutAt)) need.push("check in and check out on site");
  return need;
}

async function openBlockers(t) {
  if (!(t.blockedBy || []).length) return [];
  return repo.tasks.list({ _id: { $in: t.blockedBy }, status: { $nin: DONE } }, { projection: { taskNo: 1, title: 1, status: 1 } });
}

// Parent progress follows its subtasks: done = 100, cancelled ones are left out.
async function rollUpParent(parentId) {
  if (!parentId) return;
  const parent = await repo.tasks.findById(parentId);
  if (!parent || DONE.includes(parent.status)) return;
  const subs = (await repo.tasks.list({ parentId }, { projection: { status: 1, percent: 1 } })).filter((s) => s.status !== "Cancelled");
  if (!subs.length) return;
  const pct = Math.round(subs.reduce((n, s) => n + (["Completed", "Closed"].includes(s.status) ? 100 : Number(s.percent) || 0), 0) / subs.length);
  if (pct !== parent.percent) await repo.tasks.updateById(parentId, { $set: { percent: pct, percentRolledUp: true } });
}

async function tellUnblocked(t) {
  const waiting = await repo.tasks.list({ blockedBy: t._id, status: { $nin: DONE } }, { projection: { taskNo: 1, title: 1, blockedBy: 1, assigneeId: 1, ownerId: 1, companyId: 1 } });
  for (const w of waiting) {
    if ((await openBlockers(w)).length) continue;
    const to = [w.assigneeId || w.ownerId].filter(Boolean);
    if (to.length) await notify(w.companyId, to, { kind: "task", title: "Unblocked: " + w.taskNo, body: w.title + " · " + t.taskNo + " is " + t.status, link: { page: "tasks", id: String(w._id) }, key: "task-unblock:" + w._id + ":" + t._id });
  }
}

// Occurrence dates of a template after fromExclusive up to toInclusive (and its end date).
function periodsBetween(cap, fromExclusive, toInclusive, tpl, startDate) {
  const rule = typeof tpl === "string" ? { frequency: tpl, startDate } : tpl;
  const out = [];
  let d = fromExclusive ? shiftDate(fromExclusive, 1) : rule.startDate;
  if (d < rule.startDate) d = rule.startDate;
  const last = rule.endDate && rule.endDate < toInclusive ? rule.endDate : toInclusive;
  for (let guard = 0; d <= last && out.length < (cap || 60) && guard < 20000; guard++) {
    if (occursOn(d, rule)) out.push(d);
    d = shiftDate(d, 1);
  }
  return out;
}

// Validates the recurrence part of a template body; returns fields to store or { error }.
function recurrenceFields(b, current) {
  const r = { ...(current || {}) };
  if (b.frequency !== undefined) {
    if (!FREQUENCIES.includes(b.frequency)) return { error: "frequency must be one of " + FREQUENCIES.join(", ") };
    r.frequency = b.frequency;
  }
  if (!r.frequency) return { error: "frequency required" };
  if (b.interval !== undefined && b.interval !== "") {
    const n = Number(b.interval);
    if (!Number.isInteger(n) || n < 1 || n > 365) return { error: "repeat interval must be a whole number 1–365" };
    r.interval = n;
  }
  if (r.frequency === "Every N days" && !(r.interval > 1)) return { error: "Every N days needs an interval of 2 or more days" };
  if (b.weekdays !== undefined) {
    const days = [...new Set((Array.isArray(b.weekdays) ? b.weekdays : String(b.weekdays).split(",")).map(Number).filter((x) => x >= 1 && x <= 7))].sort();
    r.weekdays = days;
  }
  if (b.monthlyMode !== undefined) {
    if (b.monthlyMode && !MONTHLY_MODES.includes(b.monthlyMode)) return { error: "monthly mode must be date or weekday" };
    r.monthlyMode = b.monthlyMode || "date";
  }
  if (r.monthlyMode === "weekday") {
    if (b.weekday !== undefined) r.weekday = Number(b.weekday);
    if (b.nth !== undefined) r.nth = Number(b.nth);
    if (!(r.weekday >= 1 && r.weekday <= 7)) return { error: "choose the weekday for a 'first Monday' style rule" };
    if (![1, 2, 3, 4, -1].includes(r.nth)) return { error: "week of month must be 1, 2, 3, 4 or last (-1)" };
  }
  if (b.endDate !== undefined) {
    if (!b.endDate) r.endDate = null;
    else {
      const e = normDate(b.endDate);
      if (!e) return { error: "end date must be a real date (YYYY-MM-DD)" };
      r.endDate = e;
    }
  }
  if (r.endDate && r.startDate && r.endDate < r.startDate) return { error: "end date is before the start date" };
  return { fields: r };
}

const load = async (ctx) => {
  const t = await repo.tasks.findById(oid(ctx.params.id));
  if (!t || !canSee(ctx.user, t)) {
    throw new AppError(404, "not found");
  }
  return t;
};

async function getTasksMeta(ctx) {
  const companyId = oid(ctx.user.companyId);
  const cfg = await settings(companyId);
  return { status: 200, body: {
    statuses: STATUSES,
    priorities: PRIORITIES,
    categories: CATEGORIES,
    types: cfg.taskTypes.map((x) => x.name),
    taskTypes: cfg.taskTypes,
    sources: SOURCES,
    frequencies: FREQUENCIES,
    weekdays: WEEKDAYS,
    escalationLevels: ESCALATION_LEVELS,
    templateStatuses: TEMPLATE_STATUSES,
    missedPolicies: MISSED_POLICIES,
    rejectable: REJECTABLE,
    next: NEXT,
    settings: cfg,
    canCreate: canCreate(ctx.user),
    canAssign: canAssign(ctx.user),
    admin: isAdmin(ctx.user),
    export: can(ctx.user, "Export", "CRM-06") && !isFieldStaff(ctx.user),
    profile: ctx.user.taskProfile || {},
    teams: ((await repo.lookups.findOne({ companyId }, { projection: { teams: 1 } })) || {}).teams || [],
    seesAll: seesAll(ctx.user),
    workload: canCreate(ctx.user) || seesAll(ctx.user) || Object.values(cfg.teamLeads).some((uid) => same(uid, ctx.user._id)),
  } };
}

async function getTasksAssignees(ctx) {
  if (!canCreate(ctx.user)) return { status: 403, body: { error: "task creators only" } };
  const companyId = oid(ctx.user.companyId);
  const counts = await openCounts(companyId);
  const users = await assignableUsers(companyId);
  return { status: 200, body: {
    users: users.map((u) => ({ _id: u._id, name: u.name, login: u.login, hierarchy: u.hierarchy, functionalRole: u.functionalRole, taskProfile: u.taskProfile || {}, openTasks: counts.get(String(u._id)) || 0 })),
  } };
}

async function patchTasksProfileByUserId(ctx) {
  if (!isOfficeAdmin(ctx.user) || isFieldStaff(ctx.user)) return { status: 403, body: { error: "office Admin only" } };
  const u = await repo.users.findById(oid(ctx.params.userId));
  if (!u || !companyScope(ctx.user, u.companyId)) return { status: 404, body: { error: "not found" } };
  const profile = {
    team: String(ctx.body.team || "").trim(),
    region: String(ctx.body.region || "").trim(),
    skills: (Array.isArray(ctx.body.skills) ? ctx.body.skills : String(ctx.body.skills || "").split(","))
      .map((s) => String(s).trim())
      .filter(Boolean),
  };
  await repo.users.updateById(u._id, { $set: { taskProfile: profile } });
  await writeAudit(ctx, "TaskProfileChanged", { companyId: u.companyId, module: "CRM-06", recordId: u._id, before: u.taskProfile || null, after: profile });
  return { status: 200, body: { ok: true } };
}

async function patchTasksSettings(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const set = {};
  if (ctx.body.missedPolicy !== undefined) {
    if (!MISSED_POLICIES.includes(ctx.body.missedPolicy)) return { status: 400, body: { error: "missed policy must be one of " + MISSED_POLICIES.join(", ") } };
    set.taskMissedPolicy = ctx.body.missedPolicy;
  }
  const before = await settings(companyId);
  const escalation = JSON.parse(JSON.stringify(before.escalation));
  let escChanged = false;
  for (const p of ["Critical", "High"]) {
    const v = ctx.body.escalateAfterHours && ctx.body.escalateAfterHours[p];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { status: 400, body: { error: p + " escalation hours must be ≥ 0" } };
    escalation[p][1] = n;
    escChanged = true;
  }
  if (ctx.body.escalation !== undefined) {
    for (const p of PRIORITIES) {
      const row = ctx.body.escalation[p];
      if (row === undefined) continue;
      if (!Array.isArray(row) || row.length !== 3) return { status: 400, body: { error: p + " escalation needs three levels (blank = off)" } };
      const vals = row.map((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v)));
      if (vals.some((v) => v !== null && (!Number.isFinite(v) || v < 0))) return { status: 400, body: { error: p + " escalation hours must be ≥ 0" } };
      const on = vals.filter((v) => v !== null);
      if (on.some((v, i) => i && v < on[i - 1])) return { status: 400, body: { error: p + ": each level must fire at or after the level before it" } };
      escalation[p] = vals;
    }
    escChanged = true;
  }
  if (escChanged) set.taskEscalation = escalation;
  if (ctx.body.reminderRules !== undefined) {
    const r = ctx.body.reminderRules || {};
    const days = [...new Set((Array.isArray(r.daysBefore) ? r.daysBefore : String(r.daysBefore || "").split(",")).map((x) => String(x).trim()).filter(Boolean).map(Number))];
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 60)) return { status: 400, body: { error: "reminder days before due must be whole numbers 1–60" } };
    set.taskReminderRules = { daysBefore: days.sort((a, b) => b - a).slice(0, 5), onDue: r.onDue !== false && r.onDue !== "false" };
  }
  if (ctx.body.taskTypes !== undefined) {
    const rows = Array.isArray(ctx.body.taskTypes) ? ctx.body.taskTypes : [];
    const list = (v, n) => [...new Set((v || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, n);
    const clean = rows
      .map((x) => ({ name: String((x && x.name) || "").trim(), subTypes: list(x && x.subTypes, 30), evidence: list(x && x.evidence, 10), gps: !!(x && x.gps) }))
      .filter((x) => x.name);
    if (!clean.length) return { status: 400, body: { error: "keep at least one task type" } };
    if (new Set(clean.map((x) => x.name.toLowerCase())).size !== clean.length) return { status: 400, body: { error: "task type names must be unique" } };
    const used = await repo.tasks.distinct("type", { companyId, status: { $nin: DONE } });
    const dropped = used.filter((u) => u && !clean.some((x) => x.name === u));
    if (dropped.length) return { status: 400, body: { error: "open tasks still use: " + dropped.join(", ") } };
    set.taskTypes = clean.slice(0, 40);
  }
  if (ctx.body.teamLeads !== undefined) {
    const map = {};
    for (const [team, uid] of Object.entries(ctx.body.teamLeads || {})) {
      if (!String(team).trim() || !uid) continue;
      const u = await repo.users.findOne({ _id: oid(uid), companyId, active: true }, { projection: { _id: 1 } });
      if (!u) return { status: 400, body: { error: "team lead for " + team + " must be an active user of this company" } };
      map[String(team).trim()] = String(u._id);
    }
    set.taskTeamLeads = map;
  }
  if (ctx.body.approveStaffTasks !== undefined) set.taskApproveStaffTasks = ctx.body.approveStaffTasks === true || ctx.body.approveStaffTasks === "true";
  if (ctx.body.blockCloseWhileTicketOpen !== undefined) set.taskBlockCloseWhileTicketOpen = ctx.body.blockCloseWhileTicketOpen === true || ctx.body.blockCloseWhileTicketOpen === "true";
  if (ctx.body.mailRules !== undefined) {
    const rules = [];
    for (const r of Array.isArray(ctx.body.mailRules) ? ctx.body.mailRules : []) {
      const rule = { field: String(r.field || "").toLowerCase(), contains: String(r.contains || "").trim(), type: String(r.type || "").trim(), priority: String(r.priority || "Medium").trim(), assignTeam: String(r.assignTeam || "").trim() };
      if (!MAIL_RULE_FIELDS.includes(rule.field)) return { status: 400, body: { error: "rule field must be subject, body or sender" } };
      if (rule.contains.length < 2) return { status: 400, body: { error: "each rule needs a keyword of 2+ characters" } };
      if (rule.type && !before.taskTypes.some((x) => x.name === rule.type)) return { status: 400, body: { error: "rule type " + rule.type + " is not a task type" } };
      if (!PRIORITIES.includes(rule.priority)) return { status: 400, body: { error: "rule priority must be " + PRIORITIES.join(" / ") } };
      rules.push(rule);
    }
    set.taskMailRules = rules.slice(0, 30);
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.lookups.updateOne({ companyId }, { $set: set }, { upsert: true });
  await writeAudit(ctx, "TaskSettingsChanged", { companyId, module: "CRM-06", before, after: set });
  return { status: 200, body: { ok: true } };
}

async function getTasks(ctx) {
  if (!can(ctx.user, "View", "CRM-06")) return { status: 403, body: { error: "not allowed" } };
  const companyId = oid(ctx.user.companyId);
  const now = new Date();
  const filter = { companyId };
  const view = String(ctx.query.view || "mine");
  const me = ctx.user._id;
  const team = ctx.user.taskProfile && ctx.user.taskProfile.team;
  if (view === "mine") filter.assigneeId = me;
  else if (view === "created") filter.ownerId = me;
  else if (view === "shared") filter.$and = [{ $or: [{ sharedWith: me }, { supportIds: me }] }];
  else if (view === "approval") {
    filter.status = "Pending Approval";
    if (!canAssign(ctx.user)) filter.managerId = me;
  } else if (view === "rejected") filter.status = "Rejected";
  else if (view === "team") {
    if (!team) return { status: 200, body: { rows: [], view } };
    filter.team = team;
  } else if (view === "review") {
    filter.status = { $in: ["Submitted for Review", "Under Review"] };
    filter.assigneeId = { $ne: me };
  } else if (view === "overdue") {
    filter.status = { $nin: DONE };
    filter.dueAt = { $lt: now };
  }
  if (!seesAll(ctx.user) && view !== "mine") {
    filter.$or = scopeOr(me, team);
  }
  if (ctx.query.status && STATUSES.includes(ctx.query.status)) filter.status = ctx.query.status;
  if (ctx.query.priority && PRIORITIES.includes(ctx.query.priority)) filter.priority = ctx.query.priority;
  if (ctx.query.projectId && oid(ctx.query.projectId)) filter.projectId = oid(ctx.query.projectId);
  if (ctx.query.team && view !== "team") filter.team = String(ctx.query.team);
  if (ctx.query.q) {
    const rx = { $regex: String(ctx.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    filter.$and = [...(filter.$and || []), { $or: [{ title: rx }, { taskNo: rx }, { atmId: rx }, { docketNumber: rx }, { assigneeName: rx }] }];
  }
  const rows = await repo.tasks.list(filter, { projection: { history: 0, notes: 0 }, sort: { dueAt: 1 }, limit: 500 });
  const blockerIds = [...new Set(rows.flatMap((t) => (t.blockedBy || []).map(String)))];
  const openIds = new Set(blockerIds.length ? (await repo.tasks.list({ _id: { $in: blockerIds.map(oid) }, status: { $nin: DONE } }, { projection: { _id: 1 } })).map((x) => String(x._id)) : []);
  let list = rows.map((t) => ({ ...decorate(t, now), blocked: !DONE.includes(t.status) && (t.blockedBy || []).some((b) => openIds.has(String(b))) }));
  if (view === "review" && !isOfficeAdmin(ctx.user)) list = list.filter((t) => isReviewer(ctx.user, t));
  return { status: 200, body: { view, rows: list } };
}

// Open load per person: what they hold, what is late, what is due soon, and recent throughput.
async function getTasksWorkload(ctx) {
  const companyId = oid(ctx.user.companyId);
  const leads = (await settings(companyId)).teamLeads;
  const ledTeams = Object.entries(leads).filter(([, uid]) => same(uid, ctx.user._id)).map(([t]) => t);
  if (!canCreate(ctx.user) && !seesAll(ctx.user) && !ledTeams.length) return { status: 403, body: { error: "task managers and team leads only" } };
  const wantTeam = String(ctx.query.team || "").trim();
  const now = new Date();
  const today = istToday();
  const dayEnd = new Date(today + "T23:59:59.999+05:30");
  const weekEnd = new Date(shiftDate(today, 7) + "T23:59:59.999+05:30");
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  let users = await assignableUsers(companyId);
  const teamOf = (u) => (u.taskProfile && u.taskProfile.team) || u.team || "";
  if (!seesAll(ctx.user) && !canCreate(ctx.user)) users = users.filter((u) => ledTeams.includes(teamOf(u)));
  if (wantTeam) users = users.filter((u) => teamOf(u) === wantTeam);
  const ids = users.map((u) => u._id);
  const [open, done] = await Promise.all([
    repo.tasks.list({ companyId, assigneeId: { $in: ids }, status: { $nin: DONE } }, { projection: { assigneeId: 1, status: 1, dueAt: 1, priority: 1, estimatedHours: 1 } }),
    repo.tasks.aggregate([{ $match: { companyId, assigneeId: { $in: ids }, completedAt: { $gte: weekAgo } } }, { $group: { _id: "$assigneeId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const doneBy = new Map(done.map((d) => [String(d._id), d.n]));
  const rows = users.map((u) => {
    const mine = open.filter((t) => same(t.assigneeId, u._id));
    const due = (t) => (t.dueAt ? new Date(t.dueAt) : null);
    return {
      userId: u._id,
      name: u.name,
      role: u.functionalRole || u.hierarchy,
      team: teamOf(u),
      lead: !!teamOf(u) && same(leads[teamOf(u)], u._id),
      open: mine.length,
      inProgress: mine.filter((t) => t.status === "In Progress").length,
      review: mine.filter((t) => ["Submitted for Review", "Under Review"].includes(t.status)).length,
      overdue: mine.filter((t) => due(t) && due(t) < now).length,
      dueToday: mine.filter((t) => due(t) && due(t) >= now && due(t) <= dayEnd).length,
      dueWeek: mine.filter((t) => due(t) && due(t) > dayEnd && due(t) <= weekEnd).length,
      critical: mine.filter((t) => ["Critical", "High"].includes(t.priority)).length,
      estHours: Math.round(mine.reduce((s, t) => s + (Number(t.estimatedHours) || 0), 0) * 10) / 10,
      done7d: doneBy.get(String(u._id)) || 0,
    };
  });
  rows.sort((a, b) => b.overdue - a.overdue || b.open - a.open || String(a.name).localeCompare(String(b.name)));
  const teams = [...new Set((await assignableUsers(companyId)).map(teamOf).filter(Boolean))].sort();
  const unassigned = await repo.tasks.count({ companyId, status: { $nin: DONE }, assigneeId: null, ...(wantTeam ? { team: wantTeam } : {}) });
  return { status: 200, body: { rows, teams: seesAll(ctx.user) || canCreate(ctx.user) ? teams : ledTeams, unassigned, leads } };
}

async function getTasksExport(ctx) {
  if (!can(ctx.user, "Export", "CRM-06") || isFieldStaff(ctx.user)) return { status: 403, body: { error: "Export action not granted" } };
  const companyId = oid(ctx.user.companyId);
  const now = new Date();
  const filter = { companyId };
  if (!seesAll(ctx.user)) {
    const me = ctx.user._id;
    const team = ctx.user.taskProfile && ctx.user.taskProfile.team;
    filter.$or = scopeOr(me, team);
  }
  const rows = (await repo.tasks.list(filter, { sort: { createdAt: -1 }, limit: 5000 })).map((t) => decorate(t, now));
  const cols = ["taskNo", "title", "type", "subType", "category", "priority", "displayStatus", "source", "assigneeName", "team", "ownerName", "managerName", "atmId", "docketNumber", "startAt", "dueAt", "completedAt", "estimatedHours", "actualHours", "percent", "escalationLevel"];
  const csv = [cols.join(","), ...rows.map((t) => cols.map((k) => csvCell(t[k] instanceof Date ? t[k].toISOString() : t[k])).join(","))].join("\n");
  await writeAudit(ctx, "ReportExported", { companyId, module: "CRM-06", work: "tasks " + rows.length + " rows" });
  return { status: 200, body: { fileName: "tasks.csv", csv } };
}

async function getTasksById(ctx) {
  const t = await load(ctx);
  const subtasks = await repo.tasks.list({ parentId: t._id }, { projection: { taskNo: 1, title: 1, status: 1, assigneeName: 1, dueAt: 1, percent: 1 } });
  const files = await repo.documents.list({ parentType: "task", parentId: t._id }, { projection: { data: 0 }, sort: { uploadedAt: -1 } });
  const brief = { taskNo: 1, title: 1, status: 1, assigneeName: 1, dueAt: 1 };
  const blockers = (t.blockedBy || []).length ? await repo.tasks.list({ _id: { $in: t.blockedBy } }, { projection: brief }) : [];
  const blocks = await repo.tasks.list({ blockedBy: t._id }, { projection: brief });
  const support = (t.supportIds || []).length ? await repo.users.list({ _id: { $in: t.supportIds } }, { projection: { name: 1, login: 1 } }) : [];
  const parent = t.parentId ? await repo.tasks.findById(t.parentId, brief) : null;
  const office = same(t.ownerId, ctx.user._id) || same(t.managerId, ctx.user._id) || isOfficeAdmin(ctx.user);
  return { status: 200, body: {
    task: decorate(t, new Date()),
    subtasks,
    files,
    blockers,
    blocks,
    support,
    parent,
    blocked: !DONE.includes(t.status) && blockers.some((b) => !DONE.includes(b.status)),
    rule: await typeRule(t),
    evidenceMissing: DONE.includes(t.status) ? [] : await evidenceMissing(t),
    canReview: isReviewer(ctx.user, t),
    isAssignee: same(t.assigneeId, ctx.user._id),
    canManage: office,
    canApproveNew: t.status === "Pending Approval" && (same(t.managerId, ctx.user._id) || canAssign(ctx.user)) && (!same(t.ownerId, ctx.user._id) || isOfficeAdmin(ctx.user)),
    canCancel: !DONE.includes(t.status) && (same(t.ownerId, ctx.user._id) || isOfficeAdmin(ctx.user) || same(t.managerId, ctx.user._id)),
  } };
}

async function postTasksByIdFiles(ctx) {
  const t = await load(ctx);
  if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status + "; no more files" } };
  const type = String(ctx.body.type || "Attachment").trim().slice(0, 80);
  const file = checkFile(ctx.body.fileName, ctx.body.data);
  if (file.error) return { status: 400, body: { error: file.error } };
  const version = await nextVersion(t.companyId, t._id, type);
  const doc = { companyId: t.companyId, parentType: "task", parentId: t._id, type, version, fileName: file.name, mime: file.mime, ...(await storeFile(file.data, file.name, file.mime)), status: "Documents Submitted", franchiseId: t.franchiseId || null, uploadedBy: ctx.user._id, uploadedAt: new Date() };
  const r = await repo.documents.insert(doc);
  await repo.tasks.updateById(t._id, { $push: { history: historyEntry(ctx.user, "File attached", { remark: type + " v" + version + " · " + file.name }) }, $set: { updatedAt: new Date() } });
  await writeAudit(ctx, "TaskFileAttached", { companyId: t.companyId, module: "CRM-06", recordId: t._id, work: t.taskNo + " " + type + " v" + version });
  return { status: 200, body: { id: String(r.insertedId), version } };
}

async function postTasks(ctx) {
  if (!canCreate(ctx.user)) return { status: 403, body: { error: "not allowed to create tasks" } };
  const b = ctx.body;
  if ((b.assigneeId || b.assignTeam || b.assignRegion || b.assignSkill) && !canAssign(ctx.user)) return { status: 403, body: { error: "not allowed to assign" } };
  if (b.source === "Lead") return { status: 400, body: { error: "Lead is not a CRM source" } };
  if (b.source === "Recurring") return { status: 400, body: { error: "recurring tasks come from templates" } };
  const companyId = oid(ctx.user.companyId);
  const needsApproval = !canAssign(ctx.user) && (await settings(companyId)).approveStaffTasks;
  const r = await createTask(companyId, ctx.user, b, { needsApproval, strictType: true });
  if (r.error) return { status: 400, body: { error: r.error } };
  await writeAudit(ctx, "TaskCreated", { companyId, module: "CRM-06", recordId: r.task._id, work: r.task.taskNo + " " + r.task.title });
  if (r.pick) await writeAudit(ctx, "Assigned", { companyId, module: "CRM-06", recordId: r.task._id, work: r.task.taskNo + " → " + r.pick.user.name + " (" + r.pick.by + ")" });
  if (r.task.parentId) await rollUpParent(r.task.parentId);
  return { status: 200, body: { id: String(r.task._id), taskNo: r.task.taskNo, assigneeName: r.task.assigneeName, status: r.task.status } };
}

async function patchTasksById(ctx) {
  const t = await load(ctx);
  const b = ctx.body;
  const actor = ctx.user;
  const now = new Date();
  const set = { updatedAt: now };
  const push = { history: [] };
  let event = "StatusChanged";
  let work = t.taskNo;

  if (b.action === "assign" || b.action === "reassign") {
    if (!canAssign(actor)) return { status: 403, body: { error: "not allowed to assign" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    if (t.status === "Pending Approval") return { status: 400, body: { error: "approve the task before assigning it" } };
    const reassign = !!t.assigneeId;
    const reason = String(b.reason || "").trim();
    if (reassign && !reason) return { status: 400, body: { error: "reason required to reassign" } };
    const pick = await pickAssignee(t.companyId, { assigneeId: b.assigneeId, team: b.assignTeam, region: b.assignRegion, skill: b.assignSkill });
    if (pick.error) return { status: 400, body: { error: pick.error } };
    if (same(pick.user._id, t.assigneeId)) return { status: 400, body: { error: "already assigned to " + pick.user.name } };
    const a = await applyAssignment(t, pick, actor, reason);
    Object.assign(set, a.set);
    if (reassign && !["Created", "Assigned"].includes(t.status)) set.status = "Assigned";
    push.assignments = [a.entry];
    push.history.push(historyEntry(actor, reassign ? "Reassigned" : "Assigned", { from: t.status, to: set.status || t.status, remark: (t.assigneeName ? t.assigneeName + " → " : "") + pick.user.name + " (" + pick.by + ")" + (reason ? ": " + reason : "") }));
    event = reassign ? "Reassigned" : "Assigned";
    work = t.taskNo + " → " + pick.user.name + " (" + pick.by + ")" + (reason ? " " + reason : "");
    await notify(t.companyId, [pick.user._id], { kind: "assignment", title: "Task " + (reassign ? "reassigned" : "assigned") + ": " + t.taskNo, body: t.title, link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "status") {
    const to = String(b.to || "");
    const allowed = NEXT[t.status] || [];
    if (!allowed.includes(to)) return { status: 400, body: { error: t.status + " cannot move to " + to } };
    const assignee = same(t.assigneeId, actor._id);
    const reviewer = isReviewer(actor, t);
    const reason = String(b.reason || "").trim();
    if (REVIEW_STEPS.includes(to) || (to === "Closed" && t.status === "Approved")) {
      if (!reviewer) return { status: 403, body: { error: "only the owner, manager or office Admin (not the assignee) can review" } };
    } else if (to === "Closed") {
      if (!(same(t.ownerId, actor._id) || isOfficeAdmin(actor)) || (assignee && !isAdmin(actor))) return { status: 403, body: { error: "owner or office Admin closes" } };
      if (!can(actor, "Close", "CRM-06")) return { status: 403, body: { error: "Close action not granted" } };
    } else if (to === "On Hold") {
      if (!assignee && !reviewer) return { status: 403, body: { error: "assignee, owner or manager only" } };
    } else if (to === "Completed" && t.status === "Approved") {
      if (!assignee && !reviewer) return { status: 403, body: { error: "assignee or reviewer only" } };
    } else if (!assignee) return { status: 403, body: { error: "only the assignee can move the task to " + to } };
    if (to === "Completed" && t.status === "In Progress" && t.reviewRequired) return { status: 400, body: { error: "this task needs review; submit for review first" } };
    if (["In Progress", "Submitted for Review", "Completed"].includes(to)) {
      const waiting = await openBlockers(t);
      if (waiting.length) return { status: 400, body: { error: "blocked by " + waiting.map((w) => w.taskNo + " (" + w.status + ")").join(", ") } };
    }
    if (["Submitted for Review", "Completed"].includes(to) && t.status === "In Progress") {
      const need = await evidenceMissing(t);
      if (need.length) return { status: 400, body: { error: "before completing: " + need.join("; ") } };
    }
    if (["On Hold", "Rework Required"].includes(to) && !reason) return { status: 400, body: { error: "reason required" } };
    if (["Completed", "Closed"].includes(to) && t.complaintId && (await settings(t.companyId)).blockCloseWhileTicketOpen) {
      const c = await repo.complaints.findOne({ _id: t.complaintId }, { projection: { status: 1, docketNumber: 1 } });
      if (c && !["Resolved", "Closed"].includes(c.status)) return { status: 400, body: { error: "ticket " + c.docketNumber + " is still " + c.status + "; resolve it first (company setting)" } };
    }
    if (to === "Completed" || (to === "Closed" && !t.completedAt)) {
      const openSubs = await repo.tasks.count({ parentId: t._id, status: { $nin: DONE } });
      if (openSubs) return { status: 400, body: { error: openSubs + " subtask(s) still open" } };
      set.completedAt = now;
      set.percent = 100;
      if (b.actualHours !== undefined && b.actualHours !== null && b.actualHours !== "") {
        const h = Number(b.actualHours);
        if (!Number.isFinite(h) || h < 0) return { status: 400, body: { error: "actual hours must be ≥ 0" } };
        set.actualHours = h;
      }
      if (set.actualHours === undefined && (t.actualHours === null || t.actualHours === undefined)) set.actualHours = Math.round(((now - new Date(t.startedAt || t.startAt || t.createdAt)) / 3600000) * 100) / 100;
    }
    if (to === "In Progress" && !t.startedAt) set.startedAt = now;
    if (to === "Submitted for Review") set.submittedAt = now;
    if (to === "Under Review") set.reviewAt = now;
    if (to === "Closed") set.closedAt = now;
    if (to === "On Hold") set.holdReason = reason;
    set.status = to;
    push.history.push(historyEntry(actor, "Status", { from: t.status, to, remark: reason }));
    work = t.taskNo + " " + t.status + " → " + to + (reason ? " (" + reason + ")" : "");
    const tell = ["Submitted for Review", "Completed", "On Hold"].includes(to) ? [t.ownerId, t.managerId] : ["Rework Required", "Approved", "Closed"].includes(to) ? [t.assigneeId] : [];
    const tellOthers = tell.filter((x) => x && !same(x, actor._id));
    if (tellOthers.length) await notify(t.companyId, tellOthers, { kind: "task", title: t.taskNo + ": " + to, body: t.title + (reason ? " · " + reason : ""), link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "progress") {
    if (!same(t.assigneeId, actor._id)) return { status: 403, body: { error: "assignee only" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    const pct = Number(b.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { status: 400, body: { error: "percent must be 0–100" } };
    if (await repo.tasks.count({ parentId: t._id, status: { $ne: "Cancelled" } })) return { status: 400, body: { error: "progress of a parent task is rolled up from its subtasks" } };
    set.percent = pct;
    if (b.actualHours !== undefined && b.actualHours !== "") {
      const h = Number(b.actualHours);
      if (!Number.isFinite(h) || h < 0) return { status: 400, body: { error: "actual hours must be ≥ 0" } };
      set.actualHours = h;
    }
    push.history.push(historyEntry(actor, "Progress", { remark: pct + "%" }));
    event = "TaskProgress";
  } else if (b.action === "note") {
    const text = String(b.text || "").trim();
    if (!text) return { status: 400, body: { error: "note text required" } };
    push.notes = [{ at: now, by: actor._id, byName: actor.name || actor.login, text }];
    event = "TaskNote";
    work = t.taskNo + ": " + text.slice(0, 80);
  } else if (b.action === "share") {
    if (!(same(t.ownerId, actor._id) || same(t.assigneeId, actor._id) || same(t.managerId, actor._id) || isOfficeAdmin(actor))) return { status: 403, body: { error: "owner, assignee, manager or office Admin shares a task" } };
    if (!can(actor, "Assign", "CRM-06") && !same(t.ownerId, actor._id)) return { status: 403, body: { error: "Assign action not granted" } };
    const ids = (Array.isArray(b.userIds) ? b.userIds : [b.userId]).map(oid).filter(Boolean);
    if (!ids.length) return { status: 400, body: { error: "choose who to share with" } };
    const users = await repo.users.list({ _id: { $in: ids }, companyId: t.companyId, active: true, hierarchy: { $nin: FRANCHISE_LAYERS } }, { projection: { name: 1 } });
    if (users.length !== ids.length) return { status: 400, body: { error: "share with active office users of this company only" } };
    const fresh = users.filter((u) => !(t.sharedWith || []).some((x) => same(x, u._id)));
    if (!fresh.length) return { status: 400, body: { error: "already shared with them" } };
    push.sharedWith = fresh.map((u) => u._id);
    push.history.push(historyEntry(actor, "Shared", { remark: fresh.map((u) => u.name).join(", ") }));
    event = "TaskShared";
    work = t.taskNo + " shared with " + fresh.map((u) => u.name).join(", ");
    await notify(t.companyId, fresh.map((u) => u._id), { kind: "share", title: "Task shared with you: " + t.taskNo, body: t.title + " · by " + (actor.name || actor.login), link: { page: "tasks", id: String(t._id) } });
    for (const u of await repo.users.list({ _id: { $in: push.sharedWith } }, { projection: { login: 1, email: 1 } })) {
      const to = u.email || (/@/.test(u.login) ? u.login : "");
      if (to) await require("../mail/mail.service").queueAutoMail(t.companyId, { templateKey: "task-share", vars: { taskNo: t.taskNo, title: t.title, by: actor.name || actor.login, due: t.dueAt ? new Date(t.dueAt).toISOString().slice(0, 16) : "" }, to });
    }
  } else if (b.action === "remind") {
    const at = new Date(b.at);
    if (Number.isNaN(at.getTime()) || at < now) return { status: 400, body: { error: "reminder must be a future date/time" } };
    if ((t.reminders || []).filter((r) => same(r.userId, actor._id) && !r.sentAt).length >= 5) return { status: 400, body: { error: "at most 5 pending reminders per person on one task" } };
    push.reminders = [{ userId: actor._id, at, text: String(b.text || "").trim(), sentAt: null }];
    event = "TaskReminderSet";
    work = t.taskNo + " reminder " + at.toISOString();
  } else if (b.action === "edit") {
    if (!(same(t.ownerId, actor._id) || isOfficeAdmin(actor))) return { status: 403, body: { error: "owner or office Admin only" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    const before = {};
    if (b.dueAt) {
      const d = new Date(b.dueAt);
      if (Number.isNaN(d.getTime()) || d < now) return { status: 400, body: { error: "due must be a future date" } };
      set.dueAt = d;
      set.overdueAt = null;
      set.escalationLevel = 0;
      set.escalatedAt = null;
      before.dueAt = t.dueAt;
    }
    if (b.priority) {
      if (!PRIORITIES.includes(b.priority)) return { status: 400, body: { error: "unknown priority" } };
      set.priority = b.priority;
      before.priority = t.priority;
    }
    if (b.description !== undefined) set.description = String(b.description);
    if (b.title !== undefined && String(b.title).trim()) set.title = String(b.title).trim();
    if (b.type !== undefined || b.subType !== undefined) {
      const types = (await settings(t.companyId)).taskTypes;
      const type = b.type !== undefined ? b.type : t.type;
      const row = types.find((x) => x.name === type);
      if (!row) return { status: 400, body: { error: "type must be one of " + types.map((x) => x.name).join(", ") } };
      const sub = String(b.subType !== undefined ? b.subType : b.type !== undefined && b.type !== t.type ? "" : t.subType || "").trim();
      if (sub && !(row.subTypes || []).includes(sub)) return { status: 400, body: { error: "sub-type " + sub + " is not listed under " + type } };
      set.type = type;
      set.subType = sub;
      before.type = t.type;
      before.subType = t.subType || "";
    }
    push.history.push(historyEntry(actor, "Edited", { remark: Object.keys(set).filter((k) => k !== "updatedAt" && k !== "overdueAt").join(", ") }));
    event = "TaskEdited";
    work = t.taskNo + " " + JSON.stringify(before);
  } else if (b.action === "reject") {
    if (!same(t.assigneeId, actor._id)) return { status: 403, body: { error: "only the assignee can reject the task" } };
    if (!REJECTABLE.includes(t.status)) return { status: 400, body: { error: "a task can be rejected only before work starts (" + REJECTABLE.join(" / ") + ")" } };
    const reason = String(b.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "reason required to reject" } };
    Object.assign(set, { status: "Rejected", assigneeId: null, assigneeName: "", rejectedBy: actor._id, rejectedByName: actor.name || actor.login, rejectReason: reason, rejectedAt: now });
    push.history.push(historyEntry(actor, "Rejected", { from: t.status, to: "Rejected", remark: reason }));
    event = "TaskRejected";
    work = t.taskNo + " rejected by " + (actor.name || actor.login) + ": " + reason;
    const back = [t.managerId, t.ownerId].filter((x) => x && !same(x, actor._id));
    const to = back.length ? back : await companyAdmins(t.companyId);
    await notify(t.companyId, to, { kind: "task", title: "Task rejected: " + t.taskNo, body: (actor.name || actor.login) + ": " + reason + " — reassign or cancel", link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "cancel") {
    if (!(same(t.ownerId, actor._id) || same(t.managerId, actor._id) || isOfficeAdmin(actor))) return { status: 403, body: { error: "owner, manager or office Admin cancels a task" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    const reason = String(b.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "reason required to cancel" } };
    const openSubs = await repo.tasks.count({ parentId: t._id, status: { $nin: DONE } });
    if (openSubs) return { status: 400, body: { error: openSubs + " subtask(s) still open; finish or cancel them first" } };
    Object.assign(set, { status: "Cancelled", cancelledAt: now, cancelReason: reason, cancelledByName: actor.name || actor.login });
    push.history.push(historyEntry(actor, "Cancelled", { from: t.status, to: "Cancelled", remark: reason }));
    event = "TaskCancelled";
    work = t.taskNo + " cancelled: " + reason;
    const tell = [t.assigneeId, ...(t.supportIds || [])].filter((x) => x && !same(x, actor._id));
    if (tell.length) await notify(t.companyId, tell, { kind: "task", title: "Task cancelled: " + t.taskNo, body: t.title + " · " + reason, link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "approve-new") {
    if (t.status !== "Pending Approval") return { status: 400, body: { error: "task is not waiting for approval" } };
    if (!(same(t.managerId, actor._id) || canAssign(actor))) return { status: 403, body: { error: "the task's manager or a user with Assign approves" } };
    if (same(t.ownerId, actor._id) && !isOfficeAdmin(actor)) return { status: 403, body: { error: "you cannot approve your own task" } };
    set.status = "Created";
    set.approvedNewBy = actor._id;
    set.approvedNewAt = now;
    push.history.push(historyEntry(actor, "Approved", { from: "Pending Approval", to: "Created", remark: String(b.reason || "").trim() }));
    event = "TaskApproved";
    if (t.ownerId && !same(t.ownerId, actor._id)) await notify(t.companyId, [t.ownerId], { kind: "task", title: "Task approved: " + t.taskNo, body: t.title, link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "support") {
    if (!(same(t.ownerId, actor._id) || same(t.managerId, actor._id) || same(t.assigneeId, actor._id) || isOfficeAdmin(actor))) return { status: 403, body: { error: "owner, manager, assignee or office Admin picks supporting users" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    const ids = (Array.isArray(b.userIds) ? b.userIds : []).map(oid).filter(Boolean);
    if (ids.length > 10) return { status: 400, body: { error: "at most 10 supporting users" } };
    const users = ids.length ? await repo.users.list({ _id: { $in: ids }, companyId: t.companyId, active: true, hierarchy: { $nin: FRANCHISE_LAYERS } }, { projection: { name: 1 } }) : [];
    if (users.length !== ids.length) return { status: 400, body: { error: "supporting users must be active office users of this company" } };
    if (users.some((u) => same(u._id, t.assigneeId))) return { status: 400, body: { error: "the assignee is already on the task" } };
    set.supportIds = users.map((u) => u._id);
    const added = users.filter((u) => !(t.supportIds || []).some((x) => same(x, u._id)));
    push.history.push(historyEntry(actor, "Supporting users", { remark: users.map((u) => u.name).join(", ") || "none" }));
    event = "TaskSupportChanged";
    work = t.taskNo + " support: " + users.map((u) => u.name).join(", ");
    if (added.length) await notify(t.companyId, added.map((u) => u._id), { kind: "task", title: "You are supporting " + t.taskNo, body: t.title + " · by " + (actor.name || actor.login), link: { page: "tasks", id: String(t._id) } });
  } else if (b.action === "checkIn" || b.action === "checkOut") {
    if (!same(t.assigneeId, actor._id)) return { status: 403, body: { error: "assignee only" } };
    if (!["Accepted", "In Progress", "Pending", "Rework Required"].includes(t.status)) return { status: 400, body: { error: "accept the task before checking in" } };
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const hasGps = b.lat !== undefined && b.lat !== "" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if ((await typeRule(t)).gps && !hasGps) return { status: 400, body: { error: "location needed: allow GPS in the browser and try again" } };
    const gps = hasGps ? { lat, lng, accuracy: Number(b.accuracy) || null } : null;
    if (b.action === "checkIn") {
      if (t.checkInAt && !t.checkOutAt) return { status: 400, body: { error: "already checked in" } };
      Object.assign(set, { checkInAt: now, checkInGps: gps, checkOutAt: null, checkOutGps: null });
    } else {
      if (!t.checkInAt || t.checkOutAt) return { status: 400, body: { error: "check in first" } };
      Object.assign(set, { checkOutAt: now, checkOutGps: gps });
    }
    push.history.push(historyEntry(actor, b.action === "checkIn" ? "Checked in" : "Checked out", { remark: gps ? gps.lat.toFixed(5) + ", " + gps.lng.toFixed(5) : "no GPS" }));
    event = b.action === "checkIn" ? "TaskCheckIn" : "TaskCheckOut";
  } else if (b.action === "dependencies") {
    if (!(same(t.ownerId, actor._id) || same(t.managerId, actor._id) || isOfficeAdmin(actor))) return { status: 403, body: { error: "owner, manager or office Admin sets dependencies" } };
    if (DONE.includes(t.status)) return { status: 400, body: { error: "task is " + t.status } };
    const v = await validBlockers(t.companyId, t._id, b.blockedBy);
    if (v.error) return { status: 400, body: { error: v.error } };
    set.blockedBy = v.ids;
    push.history.push(historyEntry(actor, "Dependencies", { remark: v.ids.length ? v.ids.length + " blocking task(s)" : "cleared" }));
    event = "TaskDependenciesChanged";
  } else return { status: 400, body: { error: "unknown action" } };

  const update = { $set: set };
  const pushes = {};
  Object.entries(push).forEach(([k, v]) => v.length && (pushes[k] = { $each: v }));
  if (Object.keys(pushes).length) update.$push = pushes;
  const done = await repo.tasks.updateOne({ _id: t._id, status: t.status }, update);
  if (!done.matchedCount) return { status: 409, body: { error: "the task changed while you were working; reload and try again" } };
  await writeAudit(ctx, event, { companyId: t.companyId, module: "CRM-06", recordId: t._id, before: { status: t.status, assigneeId: t.assigneeId }, after: set, work });
  if (t.parentId && (set.status || set.percent !== undefined)) await rollUpParent(t.parentId);
  if (set.status && DONE.includes(set.status)) await tellUnblocked({ ...t, status: set.status });
  return { status: 200, body: { ok: true, status: set.status || t.status } };
}

async function getTaskTemplates(ctx) {
  if (!canCreate(ctx.user)) return { status: 403, body: { error: "task creators only" } };
  const rows = await repo.task_templates.list({ companyId: oid(ctx.user.companyId) }, { projection: { skipped: 0 }, sort: { createdAt: -1 } });
  const today = istToday();
  const yesterday = shiftDate(today, -1);
  const upcoming = (x) => periodsBetween(3, (x.lastPeriod || "") > yesterday ? x.lastPeriod : yesterday, shiftDate(today, 400), x);
  return { status: 200, body: { rows: rows.map((x) => ({ ...x, recurrence: describeRecurrence(x), nextDates: x.status === "Active" ? upcoming(x) : [] })) } };
}

async function postTaskTemplates(ctx) {
  if (!canAssign(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const b = ctx.body;
  const companyId = oid(ctx.user.companyId);
  const title = String(b.title || "").trim();
  if (!title) return { status: 400, body: { error: "title required" } };
  const startDate = normDate(b.startDate || istToday());
  if (!startDate) return { status: 400, body: { error: "start date must be a real date (YYYY-MM-DD)" } };
  if (startDate < shiftDate(istToday(), -31)) return { status: 400, body: { error: "start date can be at most 31 days back" } };
  const rec = recurrenceFields(b, { startDate, interval: 1, weekdays: [], monthlyMode: "date", endDate: null });
  if (rec.error) return { status: 400, body: { error: rec.error } };
  const types = (await settings(companyId)).taskTypes;
  const typeRow = types.find((x) => x.name === b.type);
  if (b.type && !typeRow) return { status: 400, body: { error: "type must be one of " + types.map((x) => x.name).join(", ") } };
  const subType = String(b.subType || "").trim();
  if (subType && !(typeRow && (typeRow.subTypes || []).includes(subType))) return { status: 400, body: { error: "sub-type " + subType + " is not listed under " + (b.type || "General") } };
  if (b.managerId && !(await repo.users.findOne({ _id: oid(b.managerId), companyId, active: true }))) return { status: 400, body: { error: "manager must be an active user of this company" } };
  const dueHours = Number(b.dueHours || 8);
  if (!Number.isFinite(dueHours) || dueHours <= 0) return { status: 400, body: { error: "due hours must be positive" } };
  if (b.assigneeId || b.assignTeam) {
    const pick = await pickAssignee(companyId, { assigneeId: b.assigneeId, team: b.assignTeam });
    if (pick.error) return { status: 400, body: { error: pick.error } };
  }
  const doc = {
    companyId,
    title,
    description: String(b.description || ""),
    type: typeRow ? typeRow.name : "General",
    subType,
    category: CATEGORIES.includes(b.category) ? b.category : "Office",
    priority: PRIORITIES.includes(b.priority) ? b.priority : "Medium",
    ...rec.fields,
    dueHours,
    assigneeId: b.assigneeId ? oid(b.assigneeId) : null,
    assignTeam: String(b.assignTeam || "").trim() || null,
    managerId: b.managerId ? oid(b.managerId) : null,
    reviewRequired: b.reviewRequired === true || b.reviewRequired === "true",
    status: "Active",
    lastPeriod: null,
    blockedCount: 0,
    createdBy: ctx.user._id,
    createdAt: new Date(),
  };
  const r = await repo.task_templates.insert(doc);
  await writeAudit(ctx, "TaskTemplateCreated", { companyId, module: "CRM-06", recordId: r.insertedId, work: title + " · " + describeRecurrence(doc) });
  return { status: 200, body: { id: String(r.insertedId) } };
}

// Template edits shape future instances only; tasks already generated keep their own fields.
async function patchTaskTemplatesById(ctx) {
  if (!canAssign(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const tpl = await repo.task_templates.findById(oid(ctx.params.id));
  if (!tpl || !companyScope(ctx.user, tpl.companyId)) return { status: 404, body: { error: "not found" } };
  const b = ctx.body;
  const set = { updatedAt: new Date() };
  if (b.status !== undefined) {
    if (!TEMPLATE_STATUSES.includes(b.status)) return { status: 400, body: { error: "status must be Active, Paused or Inactive" } };
    set.status = b.status;
    if (b.status === "Active" && tpl.status !== "Active") {
      const missed = periodsBetween(100000, tpl.lastPeriod, shiftDate(istToday(), -1), tpl);
      if (missed.length) set.lastPeriod = missed[missed.length - 1];
    }
  }
  if (b.title !== undefined) {
    if (!String(b.title).trim()) return { status: 400, body: { error: "title required" } };
    set.title = String(b.title).trim();
  }
  if (b.description !== undefined) set.description = String(b.description);
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return { status: 400, body: { error: "unknown priority" } };
    set.priority = b.priority;
  }
  if (b.dueHours !== undefined) {
    const h = Number(b.dueHours);
    if (!Number.isFinite(h) || h <= 0) return { status: 400, body: { error: "due hours must be positive" } };
    set.dueHours = h;
  }
  if (b.reviewRequired !== undefined) set.reviewRequired = b.reviewRequired === true || b.reviewRequired === "true";
  if (b.assigneeId !== undefined || b.assignTeam !== undefined) {
    const assigneeId = b.assigneeId !== undefined ? b.assigneeId : tpl.assigneeId;
    const assignTeam = b.assignTeam !== undefined ? b.assignTeam : tpl.assignTeam;
    if (assigneeId || assignTeam) {
      const pick = await pickAssignee(tpl.companyId, { assigneeId, team: assignTeam });
      if (pick.error) return { status: 400, body: { error: pick.error } };
    }
    set.assigneeId = assigneeId ? oid(assigneeId) : null;
    set.assignTeam = String(assignTeam || "").trim() || null;
  }
  if (["frequency", "interval", "weekdays", "monthlyMode", "weekday", "nth", "endDate"].some((k) => b[k] !== undefined)) {
    const rec = recurrenceFields(b, { frequency: tpl.frequency, startDate: tpl.startDate, interval: tpl.interval || 1, weekdays: tpl.weekdays || [], monthlyMode: tpl.monthlyMode || "date", weekday: tpl.weekday, nth: tpl.nth, endDate: tpl.endDate || null });
    if (rec.error) return { status: 400, body: { error: rec.error } };
    Object.assign(set, rec.fields);
  }
  if (Object.keys(set).length === 1) return { status: 200, body: { ok: true } };
  await repo.task_templates.updateById(tpl._id, { $set: set });
  const before = {};
  Object.keys(set).forEach((k) => k !== "updatedAt" && (before[k] = tpl[k] === undefined ? null : tpl[k]));
  await writeAudit(ctx, set.status && Object.keys(set).length === 2 ? "TaskTemplateStatusChanged" : "TaskTemplateEdited", { companyId: tpl.companyId, module: "CRM-06", recordId: tpl._id, before, after: set });
  return { status: 200, body: { ok: true, recurrence: describeRecurrence({ ...tpl, ...set }) } };
}

module.exports = { same, canCreate, canAssign, seesAll, canSee, isReviewer, settings, nextTaskNo, inactiveEmployeeUsers, assignableUsers, openCounts, pickAssignee, historyEntry, decorate, resolveRelated, applyAssignment, createTask, periodsBetween, recurrenceFields, validBlockers, reassignFromInactive, taskFromMailRules, openBlockers, rollUpParent, tellUnblocked, load, getTasksMeta, getTasksAssignees, patchTasksProfileByUserId, patchTasksSettings, getTasks, getTasksWorkload, getTasksExport, getTasksById, postTasksByIdFiles, postTasks, patchTasksById, getTaskTemplates, postTaskTemplates, patchTaskTemplatesById };
