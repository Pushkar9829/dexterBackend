const { isFieldStaff, isOfficeAdmin, officeRole, companyScope, can, canApproveApplication } = require("../../middlewares/rbac");
const { AppError } = require("../../middlewares/errors");
const { DONE, DEFAULT_SLA_HOURS, DEFAULT_AUTO_ESCALATE_HOURS, ESCALATION, COMPLAINT_OWNERS, FIELD_ROLES, INSPECTION_TYPES, ANSWERS, DEFAULT_CHECKLIST, itemFailed, DEFAULT_CATEGORIES, PRIORITIES, PRIORITY_LABELS, priorityLabel, priorityKey, STATUSES, CHANNELS, VISIT_OUTCOMES, SITE_STATUSES, FIELD_OWNERS } = require("./complaints.model");
const repo = require("./complaints.repository");
const { registerImporter } = require("../imports/imports.registry");
const { notify } = require("../notices/notices.service");
const { isAdmin } = require("../ops/ops.service");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { normDate, istToday, shiftDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { applyTicketSet, inTicketSet, FRANCHISE_LAYERS, inFranchiseScope, atmInProject, applyFranchiseFilter, applyRecordScope, inRecordScope, recordScope, teamMemberIds, atmIdInProject } = require("../../utils/scope");

const isFieldOnly = isFieldStaff;

function isDesk(user) {
  if (isFieldOnly(user)) return false;
  return isOfficeAdmin(user) || officeRole(user, ["Executive", "ServiceProjectOps"]);
}

function ageBucket(days) {
  if (days <= 1) return "0–1";
  if (days <= 3) return "2–3";
  if (days <= 7) return "4–7";
  if (days <= 15) return "8–15";
  if (days <= 30) return "16–30";
  return "30+";
}

function decorate(c) {
  const end = c.closedAt || c.resolvedAt || new Date();
  const ageingDays = Math.floor((new Date(end) - new Date(c.createdAt)) / 86400000);
  const open = !DONE.includes(c.status);
  const overdue = open && c.dueAt && new Date() > new Date(c.dueAt);
  const slaCompliant = c.resolvedAt && c.dueAt ? new Date(c.resolvedAt) <= new Date(c.dueAt) : null;
  return { ...c, ageingDays, ageBucket: ageBucket(ageingDays), overdue: !!overdue, slaBreached: !!(c.slaBreachedAt || overdue), slaCompliant };
}

async function slaHours(companyId) {
  const lu = await repo.lookups.findOne({ companyId });
  return { ...DEFAULT_SLA_HOURS, ...((lu && lu.slaHours) || {}) };
}

async function taxonomy(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return Array.isArray(lu.complaintCategories) && lu.complaintCategories.length ? lu.complaintCategories : DEFAULT_CATEGORIES;
}

async function checklistTemplate(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return Array.isArray(lu.inspectionChecklist) && lu.inspectionChecklist.length ? lu.inspectionChecklist : DEFAULT_CHECKLIST;
}

const blankChecklist = (tpl) => tpl.map((t) => ({ group: t.group || "", item: t.item, answer: t.answer || "passfail", photo: !!t.photo, result: "", remark: "" }));

const problemTypesOf = (tax) => [...new Set(tax.flatMap((c) => c.problemTypes || []))];

function categoryOf(tax, problemType) {
  const c = tax.find((x) => (x.problemTypes || []).includes(problemType));
  return c ? c.name : "";
}

async function slaFor(companyId, category, priority) {
  const [base, tax] = await Promise.all([slaHours(companyId), taxonomy(companyId)]);
  const c = tax.find((x) => x.name === category);
  const h = c && c.slaHours && Number(c.slaHours[priority]);
  return h > 0 ? h : base[priority] || base.Medium;
}

async function serviceSettings(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return {
    serviceMap: lu.serviceMap || {},
    autoEscalateHours: { ...DEFAULT_AUTO_ESCALATE_HOURS, ...(lu.complaintEscalateHours || {}) },
    autoEscalate: lu.complaintAutoEscalate !== false,
    verifyBeforeClose: !!lu.complaintVerifyBeforeClose,
    autoTask: lu.complaintAutoTask !== false,
    mailAutoTicket: { enabled: false, problemType: "", priority: "Medium", ...(lu.mailAutoTicket || {}) },
  };
}

const ROBOT_NAME = "Service desk robot";
const NO_TICKET_SENDER = /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i;
const AUTO_REPLY_SUBJECT = /^(auto(matic)?[ -]?reply|out of (the )?office|undeliverable|delivery status notification)/i;
const MAX_AUTO_PER_SENDER_DAY = 5;

// Picks the one ATM a mail is about: an ATM ID written in it, else the sender's only ATM. Never guesses between two.
async function atmForMail(companyId, mail) {
  const text = (mail.subject || "") + " " + (mail.body || "");
  const tokens = [...new Set((text.match(/[A-Za-z0-9][A-Za-z0-9_-]{4,19}/g) || []).slice(0, 400))];
  const asked = String(mail.atmId || "").trim();
  if (asked) tokens.unshift(asked);
  if (tokens.length) {
    const hits = await repo.atms.list({ companyId, atmId: { $in: [...tokens, ...tokens.map((t) => t.toUpperCase())] } }, { projection: { atmId: 1 }, limit: 3 });
    const ids = [...new Set(hits.map((a) => a.atmId))];
    if (ids.length === 1) return { atmId: ids[0], by: "ATM ID in the mail" };
    if (ids.length > 1) return { error: "mail names more than one ATM (" + ids.join(", ") + ")" };
  }
  const from = String(mail.from || "").toLowerCase();
  if (!from) return { error: "no ATM ID in the mail" };
  const frs = await repo.franchises.list({ companyId, email: new RegExp("^" + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }, { projection: { _id: 1 } });
  const owned = await repo.atms.list({ companyId, $or: [{ franchiseId: { $in: frs.map((f) => f._id) } }, { email: new RegExp("^" + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }] }, { projection: { atmId: 1 }, limit: 3 });
  const ids = [...new Set(owned.map((a) => a.atmId))];
  if (ids.length === 1) return { atmId: ids[0], by: "sender's only ATM" };
  return { error: ids.length ? "sender has more than one ATM and the mail names none" : "no ATM ID in the mail and the sender is not on file" };
}

// Raises a ticket from an inbound mail that matched no ticket, when the Admin has switched this on.
// Runs as the service-desk robot through the normal create path (docket, SLA, duplicate check, notices, ack mail, audit).
async function ticketFromMail(companyId, mail) {
  const cfg = (await serviceSettings(companyId)).mailAutoTicket;
  if (!cfg.enabled) return null;
  const from = String(mail.from || "");
  const own = String(require("../../config/env").MAIL_FROM || "").toLowerCase();
  if (NO_TICKET_SENDER.test(from) || (own && own.includes(from.toLowerCase()))) return { skipped: "system or no-reply sender" };
  if (AUTO_REPLY_SUBJECT.test(String(mail.subject || "").trim())) return { skipped: "automatic reply" };
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = await repo.complaints.count({ companyId, channel: "Mail", createdBy: null, frEmail: from, createdAt: { $gte: since } });
  if (recent >= MAX_AUTO_PER_SENDER_DAY) return { skipped: "sender reached " + MAX_AUTO_PER_SENDER_DAY + " auto tickets in 24 h" };
  const atm = await atmForMail(companyId, mail);
  if (atm.error) return { skipped: atm.error };
  const types = problemTypesOf(await taxonomy(companyId));
  const text = ((mail.subject || "") + " " + (mail.body || "")).toLowerCase();
  const named = types.filter((t) => text.includes(t.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  const problemType = named || (types.includes(cfg.problemType) ? cfg.problemType : "");
  if (!problemType) return { skipped: "no problem type named and no default set" };
  const ctx = { ip: "system", headers: {}, user: { _id: null, login: "service-desk-robot", name: ROBOT_NAME, hierarchy: "SubAdmin", functionalRole: "Executive", companyId, active: true } };
  const r = await createComplaint(ctx, {
    atmId: atm.atmId,
    subject: String(mail.subject || "").trim().slice(0, 200) || "Mail from " + from,
    description: String(mail.body || "").slice(0, 4000),
    problemType,
    priority: PRIORITIES.includes(cfg.priority) ? cfg.priority : "Medium",
    channel: "Mail",
    complainantName: from,
    frEmail: from,
  });
  const docket = r.json && r.json.docketNumber;
  if (!docket) return { skipped: (r.json && r.json.error) || "ticket not created" };
  const c = await repo.complaints.findOne({ companyId, docketNumber: docket }, { projection: { _id: 1, docketNumber: 1, atmId: 1, franchiseId: 1 } });
  return c ? { complaint: c, created: r.status === 200, by: r.status === 200 ? "Auto-ticket (" + atm.by + ", " + (named ? "problem named" : "default problem") + ")" : "Open ticket for ATM + problem (" + atm.by + ")" } : { skipped: "ticket not found after create" };
}

function mappedOwners(settings, atm) {
  const m = settings.serviceMap;
  return m[atm.region || ""] || m[atm.city || ""] || m["*"] || null;
}

async function sweepComplaints(companyId, now) {
  const out = { escalated: 0 };
  const s = await serviceSettings(companyId);
  if (!s.autoEscalate) return out;
  const late = await repo.complaints.list({ companyId, status: { $nin: DONE }, dueAt: { $ne: null, $lt: now } }, { projection: { history: 0 } });
  const { companyAdmins, officeDesk } = require("../notices/notices.service");
  for (const c of late) {
    const level = c.escalationLevel || 0;
    const next = level + 1;
    if (next >= ESCALATION.length) continue;
    const hoursLate = (now - new Date(c.dueAt)) / 3600000;
    if (hoursLate < s.autoEscalateHours[ESCALATION[next]]) continue;
    const entry = { at: now, by: null, byName: "system", action: "Escalated", from: c.status, to: "Escalated", remark: "auto: " + Math.floor(hoursLate) + " h past SLA → " + ESCALATION[next] };
    const r = await repo.complaints.updateOne(
      { _id: c._id, escalationLevel: c.escalationLevel === undefined ? { $in: [0, null] } : level, status: { $nin: DONE } },
      { $set: { escalationLevel: next, status: "Escalated", lastAction: "Auto-escalated to " + ESCALATION[next], updatedAt: now }, $push: { history: entry } }
    );
    if (!r.modifiedCount) continue;
    const users = next === ESCALATION.length - 1 ? await companyAdmins(companyId) : [c.ownerUserId, ...(await officeDesk(companyId))];
    await notify(companyId, users, { kind: "escalation", title: "Ticket auto-escalated to " + ESCALATION[next] + ": " + c.docketNumber, body: "ATM " + c.atmId + " · " + (c.ssm && next === 1 ? "SSM " + c.ssm : c.rm && next === 2 ? "RM " + c.rm : ""), link: { page: "service", id: String(c._id) }, key: "tkt-esc" + next + ":" + c._id });
    await writeAudit({ user: { login: "system" }, headers: {}, ip: "" }, "AutoEscalated", { companyId, module: "CRM-05", recordId: c._id, before: { escalationLevel: level }, after: { escalationLevel: next }, work: c.docketNumber + " → " + ESCALATION[next] });
    out.escalated++;
  }
  return out;
}

async function ticketTask(row, owner, actor) {
  const s = await serviceSettings(row.companyId);
  if (!s.autoTask || !owner) return null;
  const open = await repo.tasks.findOne({ companyId: row.companyId, complaintId: row._id, source: "Ticket", assigneeId: owner, status: { $nin: ["Completed", "Closed"] } });
  if (open) return null;
  const { createTask } = require("../tasks/tasks.service");
  const r = await createTask(
    row.companyId,
    actor,
    { title: "Ticket " + row.docketNumber + ": " + row.subject, description: row.problemType + " at ATM " + row.atmId, source: "Ticket", type: "Service", category: "Office", priority: row.priority, complaintId: row._id, atmId: row.atmId, assigneeId: owner, dueAt: row.dueAt },
    { allowPastDue: true }
  );
  return r.task || null;
}

async function closeTicketTasks(row, actor, why) {
  await repo.tasks.updateMany(
    { companyId: row.companyId, complaintId: row._id, source: "Ticket", status: { $nin: ["Completed", "Closed"] } },
    { $set: { status: "Closed", completedAt: new Date(), updatedAt: new Date() }, $push: { history: { at: new Date(), by: actor._id || null, byName: actor.name || actor.login || "system", action: "Closed", to: "Closed", remark: why } } }
  );
}

async function nextDocket(companyId) {
  const company = await repo.companies.findById(companyId);
  const d = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, "");
  const key = "docket:" + companyId + ":" + d;
  const r = await repo.counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  const seq = (r && r.value ? r.value : r).seq;
  return "DKT-" + ((company && company.code) || "CO") + "-" + d + "-" + String(seq).padStart(4, "0");
}

function istDateTime(v) {
  const s = String(v || "").trim();
  return new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s + "+05:30" : s);
}

function istText(d) {
  return new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 16).replace("T", " ");
}

function historyEntry(ctx, action, extra) {
  return { at: new Date(), by: ctx.user._id, byName: ctx.user.name || ctx.user.login, action, ...extra };
}

async function findAtm(user, companyId, atmId) {
  const id = String(atmId || "").trim();
  if (!id) return { error: "ATM ID required" };
  const atm = await repo.atms.findOne({ companyId, atmId: id });
  if (!atm) return { error: "ATM ID " + id + " is not in this company's ATM Master" };
  if (FRANCHISE_LAYERS.includes(user.hierarchy) && !(await inFranchiseScope(user, atm.franchiseId))) return { error: "own ATMs only" };
  if (!atmInProject(user, atm)) return { error: "ATM " + id + " is outside your projects" };
  return { atm };
}

async function officer(companyId, id, roles) {
  const u = await repo.users.findOne({ _id: oid(id), companyId, active: true });
  if (!u || !roles.includes(u.functionalRole)) return null;
  return u;
}

async function complaintFilter(ctx) {
  const filter = { companyId: oid(ctx.user.companyId) };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  if (isFieldOnly(ctx.user)) filter.visitOfficerIds = ctx.user._id;
  else {
    await applyRecordScope(ctx.user, filter, COMPLAINT_OWNERS, "team");
    applyTicketSet(ctx.user, filter);
  }
  return filter;
}

async function inComplaintScope(user, row) {
  if (await inRecordScope(user, row, ["ownerUserId", "createdBy"], "team")) return true;
  const level = recordScope(user);
  if (level === "all") return true;
  const ids = (level === "own" ? [user._id] : await teamMemberIds(user)).map(String);
  return (row.visitOfficerIds || []).some((x) => ids.includes(String(x)));
}

async function loadComplaint(ctx) {
  const row = await repo.complaints.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) {
    throw new AppError(404, "not found");
  }
  if (!(await inFranchiseScope(ctx.user, row.franchiseId)) || !(await atmIdInProject(ctx.user, row.companyId, row.atmId))) {
    throw new AppError(403, "own records only");
  }
  if (isFieldOnly(ctx.user) && !(row.visitOfficerIds || []).some((x) => String(x) === String(ctx.user._id))) {
    throw new AppError(403, "assigned visits only");
  }
  if (!isFieldOnly(ctx.user) && !(await inComplaintScope(ctx.user, row))) {
    throw new AppError(403, recordScope(ctx.user) === "own" ? "own records only" : "team records only");
  }
  if (!isFieldOnly(ctx.user) && !inTicketSet(ctx.user, row)) throw new AppError(403, "ticket outside your assigned categories / dockets");
  return row;
}

async function saveInspectionRow(ctx, input, batchId) {
  const date = normDate(input.date);
  if (!date) return { errors: [{ column: "date", reason: "date must be YYYY-MM-DD or DD.MM.YYYY" }] };
  const f = await findAtm(ctx.user, ctx.companyId, input.atmId);
  if (f.error) return { errors: [{ column: "atmId", reason: f.error }] };
  const login = String(input.officer || "").trim().toLowerCase();
  const u = login ? await repo.users.findOne({ companyId: ctx.companyId, login, active: true }) : null;
  if (!u || !FIELD_ROLES.includes(u.functionalRole)) return { errors: [{ column: "officer", reason: "officer must be an active Inspector / Sales Officer login in this company" }] };
  const type = String(input.type || "Routine").trim();
  if (!INSPECTION_TYPES.includes(type)) return { errors: [{ column: "type", reason: "type must be " + INSPECTION_TYPES.join(" / ") }] };
  const key = { companyId: ctx.companyId, atmId: f.atm.atmId, date, type };
  const existing = await repo.inspections.findOne(key);
  if (existing && existing.status !== "Assigned") return { errors: [{ column: "date", reason: "inspection already " + existing.status }] };
  if (existing && existing.checkInAt && String(existing.officerId) !== String(u._id)) return { errors: [{ column: "officer", reason: "officer already checked in; cannot hand over" }] };
  await repo.inspections.updateOne(
    key,
    {
      $set: { atmRef: f.atm._id, franchiseId: f.atm.franchiseId || null, officerId: u._id, officerName: u.name, source: "import", importBatchId: batchId, updatedAt: new Date() },
      $setOnInsert: { status: "Assigned", checklist: blankChecklist(await checklistTemplate(ctx.companyId)), createdBy: ctx.user._id, createdAt: new Date() },
    },
    { upsert: true }
  );
  if (!existing || String(existing.officerId) !== String(u._id)) {
    const row = await repo.inspections.findOne(key);
    await notify(ctx.companyId, [u._id], { kind: "assignment", title: "Inspection assigned: " + f.atm.atmId, body: type + " on " + date, link: { page: "service", id: String(row._id), type: "inspection" } });
  }
  return { ok: true, key: f.atm.atmId + " " + date };
}

registerImporter("inspection-list", {
  headers: ["atmId", "date", "officer", "type"],
  canImport: isAdmin,
  denied: "inspection list import is Admin only",
  save: saveInspectionRow,
  event: "InspectionListImported",
  module: "CRM-05",
});

async function getServiceMeta(ctx) {
  const tax = await taxonomy(oid(ctx.user.companyId));
  return { status: 200, body: {
    problemTypes: problemTypesOf(tax),
    categories: tax,
    priorities: PRIORITIES,
    priorityLabels: PRIORITY_LABELS,
    statuses: STATUSES,
    channels: CHANNELS,
    escalation: ESCALATION,
    visitOutcomes: VISIT_OUTCOMES,
    siteStatuses: SITE_STATUSES,
    inspectionTypes: INSPECTION_TYPES,
    checklist: await checklistTemplate(oid(ctx.user.companyId)),
    answers: ANSWERS,
    slaHours: await slaHours(oid(ctx.user.companyId)),
    teams: ((await repo.lookups.findOne({ companyId: oid(ctx.user.companyId) })) || {}).teams || [],
    settings: await serviceSettings(oid(ctx.user.companyId)),
    desk: isDesk(ctx.user),
    canExport: can(ctx.user, "Export", "CRM-05") && !isFieldStaff(ctx.user),
    fieldOnly: isFieldOnly(ctx.user),
    canAssign: isDesk(ctx.user) && can(ctx.user, "Assign", "CRM-05"),
    canClose: FRANCHISE_LAYERS.includes(ctx.user.hierarchy) || (isDesk(ctx.user) && can(ctx.user, "Close", "CRM-05")),
    canVerifyInspection: canApproveApplication(ctx.user) && !isFieldOnly(ctx.user),
  } };
}

async function getServiceBoard(ctx) {
  const companyId = oid(ctx.user.companyId);
  const now = new Date();
  const soon = new Date(now.getTime() + 3600 * 1000);
  const dayStart = new Date(istToday() + "T00:00:00+05:30");
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const cf = await complaintFilter(ctx);
  const open = (await repo.complaints.list({ ...cf, status: { $nin: DONE } }, { projection: { history: 0 }, sort: { dueAt: 1 }, limit: 1000 })).map(decorate);
  const toVerify = (await repo.complaints.list({ ...cf, status: "Resolved", verifiedAt: null }, { projection: { history: 0 }, sort: { resolvedAt: 1 }, limit: 200 })).map(decorate);
  const vf = { companyId, open: true };
  await applyFranchiseFilter(ctx.user, vf, "franchiseId");
  if (isFieldOnly(ctx.user)) vf.officerId = ctx.user._id;
  else await applyRecordScope(ctx.user, vf, FIELD_OWNERS);
  const visits = await repo.visits.list({ ...vf, scheduledAt: { $lt: dayEnd } }, { sort: { scheduledAt: 1 }, limit: 300 });
  const inf = { companyId };
  await applyFranchiseFilter(ctx.user, inf, "franchiseId");
  if (isFieldOnly(ctx.user)) inf.officerId = ctx.user._id;
  else await applyRecordScope(ctx.user, inf, FIELD_OWNERS);
  const today = istToday();
  const inspections = await repo.inspections.list({ ...inf, status: { $in: ["Assigned", "Submitted"] } }, { projection: { checklist: 0 }, sort: { date: 1 }, limit: 300 });
  const me = String(ctx.user._id);
  const slim = (c) => ({ _id: c._id, docketNumber: c.docketNumber, atmId: c.atmId, problemType: c.problemType, priority: c.priority, status: c.status, dueAt: c.dueAt, overdue: c.overdue, ownerName: c.ownerName, franchiseName: c.franchiseName, resolvedBy: c.resolvedBy || null });
  return {
    status: 200,
    body: {
      me,
      mine: open.filter((c) => String(c.ownerUserId || "") === me).map(slim),
      unassigned: isDesk(ctx.user) ? open.filter((c) => !c.ownerUserId).map(slim) : [],
      breaching: open.filter((c) => c.dueAt && new Date(c.dueAt) <= soon).map(slim),
      toVerify: isDesk(ctx.user) ? toVerify.filter((c) => String(c.resolvedBy || "") !== me).map(slim) : [],
      toClose: FRANCHISE_LAYERS.includes(ctx.user.hierarchy) ? toVerify.concat((await repo.complaints.list({ ...cf, status: "Resolved", verifiedAt: { $ne: null } }, { projection: { history: 0 }, limit: 200 })).map(decorate)).map(slim) : [],
      visitsToday: visits.filter((v) => new Date(v.scheduledAt) >= dayStart),
      visitsOverdue: visits.filter((v) => new Date(v.scheduledAt) < dayStart && v.status !== "CheckedIn"),
      visitsInProgress: visits.filter((v) => v.status === "CheckedIn"),
      inspectionsDue: inspections.filter((x) => x.status === "Assigned" && x.date <= today),
      inspectionsToVerify: canApproveApplication(ctx.user) && !isFieldOnly(ctx.user) ? inspections.filter((x) => x.status === "Submitted" && String(x.officerId) !== me) : [],
    },
  };
}

async function patchServiceSla(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const set = {};
  for (const p of PRIORITIES) {
    if (ctx.body[p] === undefined) continue;
    const h = Number(ctx.body[p]);
    if (!Number.isFinite(h) || h <= 0) return { status: 400, body: { error: p + " SLA hours must be positive" } };
    set["slaHours." + p] = h;
  }
  const before = await slaHours(companyId);
  await repo.lookups.updateOne({ companyId }, { $set: set }, { upsert: true });
  await writeAudit(ctx, "SLAChanged", { companyId, module: "CRM-05", before, after: set });
  return { status: 200, body: { ok: true } };
}

async function patchServiceSettings(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body;
  const set = {};
  if (b.serviceMap !== undefined) {
    if (!b.serviceMap || typeof b.serviceMap !== "object" || Array.isArray(b.serviceMap)) return { status: 400, body: { error: "serviceMap must be { region: { ssm, rm } }" } };
    const map = {};
    for (const [k, v] of Object.entries(b.serviceMap)) {
      const key = String(k).trim();
      if (!key || key.includes(".") || key.startsWith("$")) return { status: 400, body: { error: "bad region key: " + k } };
      map[key] = { ssm: String((v && v.ssm) || "").trim(), rm: String((v && v.rm) || "").trim() };
    }
    set.serviceMap = map;
  }
  if (b.autoEscalateHours) {
    for (const lvl of ESCALATION.slice(1)) {
      const v = b.autoEscalateHours[lvl];
      if (v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { status: 400, body: { error: lvl + " hours must be ≥ 0" } };
      set["complaintEscalateHours." + lvl] = n;
    }
  }
  if (b.autoEscalate !== undefined) set.complaintAutoEscalate = !!b.autoEscalate;
  if (b.verifyBeforeClose !== undefined) set.complaintVerifyBeforeClose = !!b.verifyBeforeClose;
  if (b.autoTask !== undefined) set.complaintAutoTask = !!b.autoTask;
  if (b.mailAutoTicket !== undefined) {
    const m = b.mailAutoTicket || {};
    const problemType = String(m.problemType || "").trim();
    if (problemType && !problemTypesOf(await taxonomy(companyId)).includes(problemType)) return { status: 400, body: { error: "default problem type is not in the categories: " + problemType } };
    if (m.priority && !PRIORITIES.includes(m.priority)) return { status: 400, body: { error: "unknown priority " + m.priority } };
    set.mailAutoTicket = { enabled: !!m.enabled, problemType, priority: m.priority || "Medium" };
  }
  if (b.categories !== undefined) {
    if (!Array.isArray(b.categories) || !b.categories.length) return { status: 400, body: { error: "give at least one category" } };
    const seenCat = new Set();
    const seenType = new Set();
    const list = [];
    for (const c of b.categories) {
      const name = String((c && c.name) || "").trim();
      const types = [...new Set((Array.isArray(c && c.problemTypes) ? c.problemTypes : []).map((t) => String(t).trim()).filter(Boolean))];
      if (!name) return { status: 400, body: { error: "every category needs a name" } };
      if (seenCat.has(name.toLowerCase())) return { status: 400, body: { error: "category listed twice: " + name } };
      if (!types.length) return { status: 400, body: { error: name + ": add at least one problem type" } };
      const clash = types.find((t) => seenType.has(t.toLowerCase()));
      if (clash) return { status: 400, body: { error: "problem type in two categories: " + clash } };
      const sla = {};
      for (const [raw, v] of Object.entries((c && c.slaHours) || {})) {
        if (v === "" || v == null) continue;
        const p = priorityKey(raw);
        if (!PRIORITIES.includes(p)) return { status: 400, body: { error: name + ": unknown priority " + p } };
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { status: 400, body: { error: name + ": " + p + " SLA hours must be positive" } };
        sla[p] = n;
      }
      seenCat.add(name.toLowerCase());
      types.forEach((t) => seenType.add(t.toLowerCase()));
      list.push({ name, problemTypes: types, slaHours: sla });
    }
    const used = await repo.complaints.distinct("problemType", { companyId, status: { $nin: DONE } });
    const dropped = used.filter((t) => t && !seenType.has(String(t).toLowerCase()));
    if (dropped.length) return { status: 400, body: { error: "open tickets still use: " + dropped.join(", ") + " — keep these problem types until those tickets close" } };
    set.complaintCategories = list;
  }
  if (b.checklist !== undefined) {
    if (!Array.isArray(b.checklist) || !b.checklist.length) return { status: 400, body: { error: "checklist needs at least one item" } };
    const seen = new Set();
    const list = [];
    for (const c of b.checklist) {
      const item = String((c && c.item) || "").trim();
      const answer = String((c && c.answer) || "passfail");
      if (!item) return { status: 400, body: { error: "every checklist item needs a name" } };
      if (seen.has(item.toLowerCase())) return { status: 400, body: { error: "checklist item listed twice: " + item } };
      if (!ANSWERS[answer]) return { status: 400, body: { error: item + ": answer must be " + Object.keys(ANSWERS).join(" / ") } };
      seen.add(item.toLowerCase());
      list.push({ group: String((c && c.group) || "").trim(), item, answer, photo: !!(c && c.photo) });
    }
    set.inspectionChecklist = list;
  }
  if (!Object.keys(set).length) return { status: 400, body: { error: "nothing to change" } };
  const before = await serviceSettings(companyId);
  await repo.lookups.updateOne({ companyId }, { $set: set }, { upsert: true });
  await writeAudit(ctx, "ServiceSettingsChanged", { companyId, module: "CRM-05", before, after: set });
  return { status: 200, body: { ok: true, settings: await serviceSettings(companyId) } };
}

async function getServiceOfficers(ctx) {
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk only" } };
  const list = await repo.users.list({ companyId: oid(ctx.user.companyId), active: true, functionalRole: { $in: FIELD_ROLES } }, { projection: { name: 1, login: 1, functionalRole: 1, mobile: 1 }, sort: { name: 1 } });
  return { status: 200, body: { officers: list } };
}

async function getComplaints(ctx) {
  const filter = await complaintFilter(ctx);
  if (ctx.query.status) filter.status = String(ctx.query.status);
  if (ctx.query.atmId) filter.atmId = String(ctx.query.atmId);
  const view = String(ctx.query.view || "");
  const q = { ...filter, $and: [...(filter.$and || [])] };
  if (view === "open") q.$and.push({ status: { $nin: DONE } });
  if (view === "overdue") q.$and.push({ status: { $nin: DONE } }, { dueAt: { $lt: new Date() } });
  if (view === "done") q.$and.push({ status: { $in: DONE } });
  if (view === "mine") q.$and.push({ status: { $nin: DONE } }, { $or: [{ ownerUserId: ctx.user._id }, { createdBy: ctx.user._id }] });
  if (view === "breaching") q.$and.push({ status: { $nin: DONE } }, { dueAt: { $ne: null, $lte: new Date(Date.now() + 3600 * 1000) } });
  if (view === "toVerify") q.$and.push({ status: "Resolved" }, { verifiedAt: null });
  if (ctx.query.priority && PRIORITIES.includes(String(ctx.query.priority))) q.$and.push({ priority: String(ctx.query.priority) });
  const text = String(ctx.query.q || "").trim().slice(0, 60);
  if (text) {
    const rx = { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    q.$and.push({ $or: [{ docketNumber: rx }, { subject: rx }, { atmId: rx }, { complainantName: rx }, { franchiseName: rx }, { problemType: rx }] });
  }
  if (!q.$and.length) delete q.$and;
  const list = (await repo.complaints.list(q, { projection: { history: 0 }, sort: { createdAt: -1 }, limit: 500 })).map(decorate);
  const openFilter = { ...filter, $and: [...(filter.$and || []), { status: { $nin: DONE } }] };
  const open = await repo.complaints.list(openFilter, { projection: { createdAt: 1, status: 1 } });
  const buckets = {};
  open.map(decorate).forEach((c) => (buckets[c.ageBucket] = (buckets[c.ageBucket] || 0) + 1));
  return { status: 200, body: { complaints: list, buckets } };
}

async function getComplaintsById(ctx) {
  const row = await loadComplaint(ctx);
  const visits = await repo.visits.list({ complaintId: row._id }, { sort: { createdAt: -1 } });
  const files = await repo.documents.list({ companyId: row.companyId, $or: [{ parentType: "complaint", parentId: row._id }, { parentType: "visit", parentId: { $in: visits.map((v) => v._id) } }] }, { projection: { data: 0 }, sort: { uploadedAt: -1 } });
  const officerIds = [...new Set([...(row.visitOfficerIds || []), ...visits.map((v) => v.officerId)].filter(Boolean).map(String))].map(oid);
  const officers = officerIds.length ? await repo.users.list({ _id: { $in: officerIds } }, { projection: { name: 1, mobile: 1, functionalRole: 1 } }) : [];
  const atm = row.atmId ? await repo.atms.findOne({ companyId: row.companyId, atmId: row.atmId }, { projection: { salesOfficer: 1 } }) : null;
  return { status: 200, body: { complaint: decorate(row), visits, files, officers, atmSalesOfficer: (atm && atm.salesOfficer) || "" } };
}

async function postComplaints(ctx) {
  if (isFieldOnly(ctx.user)) return { status: 403, body: { error: "field staff update assigned visits only" } };
  const r = await createComplaint(ctx, ctx.body);
  return { status: r.status || 200, body: r.json };
}

async function getComplaintsExport(ctx) {
  if (!can(ctx.user, "Export", "CRM-05") || isFieldStaff(ctx.user)) return { status: 403, body: { error: "Export not granted" } };
  const filter = { companyId: oid(ctx.user.companyId) };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  await applyRecordScope(ctx.user, filter, COMPLAINT_OWNERS, "team");
  applyTicketSet(ctx.user, filter);
  if (ctx.query.from || ctx.query.to) {
    filter.createdAt = {};
    if (ctx.query.from) filter.createdAt.$gte = new Date(String(ctx.query.from) + "T00:00:00+05:30");
    if (ctx.query.to) filter.createdAt.$lte = new Date(String(ctx.query.to) + "T23:59:59+05:30");
  }
  const rows = await repo.complaints.list(filter, { sort: { createdAt: -1 }, limit: 20000 });
  const head = ["docket", "raisedOn", "channel", "atmId", "siteId", "city", "region", "state", "franchise", "complainant", "mobile", "frEmail", "subject", "problemType", "category", "priority", "status", "team", "owner", "ssm", "rm", "reportingAuthority", "escalationLevel", "reminderAt", "lastAction", "forwardedTo", "forwardedOn", "externalEngineer", "engineerNumber", "flmDone", "outcome", "dueAt", "slaBreached", "slaCompliant", "resolution", "resolvedAt", "closedAt", "closureRemarks"];
  const iso = (d) => (d ? new Date(d).toISOString() : "");
  const lines = rows.map((c) => [
    c.docketNumber, iso(c.createdAt), c.channel, c.atmId, c.siteId, c.city, c.region, c.state, c.franchiseName, c.complainantName, c.complainantMobile, c.frEmail, c.subject, c.problemType, c.category, priorityLabel(c.priority), c.status, c.team || "", c.ownerName, c.ssm || "", c.rm || "", c.reportingAuthority || "", ESCALATION[c.escalationLevel || 0] || "", iso(c.reminderAt), c.lastAction || "", c.forwardedTo, iso(c.forwardedOn), c.externalEngineerName || "", c.externalEngineerNumber || "",
    c.flmDone ? "Yes" : "No", c.outcome || "", iso(c.dueAt), c.slaBreachedAt ? "Yes" : "No", c.resolvedAt ? (new Date(c.resolvedAt) <= new Date(c.dueAt) ? "Yes" : "No") : "", c.resolution, iso(c.resolvedAt), iso(c.closedAt), c.closureRemarks,
  ]);
  await writeAudit(ctx, "ReportExported", { companyId: filter.companyId, module: "CRM-05", work: "complaint register " + rows.length + " rows" });
  return { status: 200, body: { fileName: "complaint-register.csv", csv: "\uFEFF" + [head, ...lines].map((r) => r.map(csvCell).join(",")).join("\n") } };
}

async function createComplaint(ctx, b) {
  {
    const companyId = oid(ctx.user.companyId);
    const fail = (status, json) => ({ status, json });
    const f = await findAtm(ctx.user, companyId, b.atmId);
    if (f.error) return fail(400, { error: f.error });
    const subject = String(b.subject || "").trim();
    const problemType = String(b.problemType || "");
    if (!subject) return fail(400, { error: "subject required" });
    const tax = await taxonomy(companyId);
    if (!problemTypesOf(tax).includes(problemType)) return fail(400, { error: "choose a problem type" });
    const category = categoryOf(tax, problemType);
    const dup = await repo.complaints.findOne({ companyId, atmId: f.atm.atmId, problemType, status: { $nin: DONE } });
    if (dup) return fail(409, { error: "an open complaint already exists for this ATM and problem: docket " + dup.docketNumber, docketNumber: dup.docketNumber });
    const franchiseUser = FRANCHISE_LAYERS.includes(ctx.user.hierarchy);
    const priority = !franchiseUser && PRIORITIES.includes(b.priority) ? b.priority : "Medium";
    const hours = await slaFor(companyId, category, priority);
    const franchise = f.atm.franchiseId ? await repo.franchises.findById(f.atm.franchiseId) : null;
    const now = new Date();
    const docketNumber = await nextDocket(companyId);
    const mapped = mappedOwners(await serviceSettings(companyId), f.atm) || {};
    const doc = {
      companyId,
      docketNumber,
      channel: franchiseUser ? "App" : CHANNELS.includes(b.channel) ? b.channel : "CRM",
      atmId: f.atm.atmId,
      atmRef: f.atm._id,
      siteId: f.atm.siteId || "",
      city: f.atm.city || "",
      franchiseId: f.atm.franchiseId || null,
      franchiseName: franchise ? franchise.name : f.atm.franchiseeName || "",
      complainantName: String(b.complainantName || ctx.user.name || ""),
      complainantMobile: String(b.complainantMobile || ""),
      frEmail: String(b.frEmail || (franchise && franchise.email) || f.atm.email || ""),
      state: String(b.state || f.atm.state || (franchise && franchise.state) || ""),
      reportingAuthority: String(b.reportingAuthority || ""),
      subject,
      description: String(b.description || ""),
      problemType,
      category,
      priority,
      status: "Open",
      openKey: f.atm.atmId + "|" + problemType,
      dueAt: new Date(now.getTime() + hours * 3600 * 1000),
      escalationLevel: 0,
      region: f.atm.region || "",
      ssm: mapped.ssm || "",
      rm: mapped.rm || "",
      forwardedTo: "",
      forwardedOn: null,
      team: "",
      flmDone: false,
      outcome: "",
      ownerUserId: null,
      ownerName: "",
      ownerNumber: "",
      reminderAt: null,
      lastAction: "Acknowledged with docket " + docketNumber,
      visitOfficerIds: [],
      resolution: "",
      closureRemarks: "",
      history: [],
      createdBy: ctx.user._id,
      createdAt: now,
      updatedAt: now,
    };
    doc.history.push(historyEntry(ctx, "Created", { to: "Open", remark: "Acknowledged with docket " + docketNumber }));
    let result;
    try {
      result = await repo.complaints.insert(doc);
    } catch (err) {
      if (err.code !== 11000) throw err;
      const other = await repo.complaints.findOne({ companyId, openKey: doc.openKey });
      return fail(409, { error: "an open complaint already exists for this ATM and problem" + (other ? ": docket " + other.docketNumber : ""), docketNumber: other && other.docketNumber });
    }
    doc._id = result.insertedId;
    await writeAudit(ctx, "TicketCreated", { companyId, module: "CRM-05", recordId: result.insertedId, work: docketNumber + " " + doc.atmId + " " + problemType });
    const ack = "Complaint registered. Your docket number is " + docketNumber;
    const ns = require("../notices/notices.service");
    await ns.notifyFranchise(companyId, doc.franchiseId, { kind: "complaint", title: "Docket " + docketNumber + " registered", body: "ATM " + doc.atmId + " · " + problemType, link: { page: "service", id: String(doc._id), type: "complaint" } });
    await ns
      .notify(companyId, (await ns.officeDesk(companyId)).filter((x) => String(x) !== String(ctx.user._id)), { kind: "complaint", title: "New ticket " + docketNumber + " (" + priorityLabel(priority) + ")", body: "ATM " + doc.atmId + " · " + problemType + " · via " + doc.channel, link: { page: "service", id: String(doc._id), type: "complaint" }, key: "tkt-new:" + doc._id })
      .catch(() => {});
    const to = [doc.frEmail, ...(await require("../mail/mail.service").franchiseEmail(companyId, doc.franchiseId, f.atm))].filter(Boolean);
    const mailId = to.length ? await require("../mail/mail.service").queueAutoMail(companyId, { templateKey: "ack", vars: require("../mail/mail.service").ticketVars(doc), to, complaintId: doc._id, franchiseId: doc.franchiseId, atmId: doc.atmId, docketNumber }) : null;
    if (mailId) await repo.complaints.updateById(doc._id, { $set: { ackMailId: mailId } });
    return { status: 200, json: { id: String(result.insertedId), docketNumber, message: ack, ackMail: mailId ? "queued" : "no franchise email on file" } };
  }
}

async function ticketNotices(ctx, row, set, event) {
  const ns = require("../notices/notices.service");
  const me = String(ctx.user._id);
  const others = (ids) => ids.filter((x) => x && String(x) !== me);
  const link = { page: "service", id: String(row._id), type: "complaint" };
  const tag = row.docketNumber + " · ATM " + row.atmId;
  if (set.status === "Resolved") {
    await ns.notifyFranchise(row.companyId, row.franchiseId, { kind: "complaint", title: "Ticket resolved — please confirm and close: " + row.docketNumber, body: set.resolution || "", link, key: "tkt-resolved:" + row._id + ":" + set.resolvedAt.getTime() });
    await ns.notify(row.companyId, others(await ns.officeDesk(row.companyId)), { kind: "complaint", title: "Resolution to verify: " + row.docketNumber, body: set.resolution || tag, link, key: "tkt-verify:" + row._id + ":" + set.resolvedAt.getTime() });
  } else if (event === "Closed" || set.status === "Reopened") {
    await ns.notify(row.companyId, others([row.ownerUserId, row.createdBy]), { kind: "complaint", title: "Ticket " + set.status.toLowerCase() + ": " + row.docketNumber, body: set.closureRemarks || set.lastAction || tag, link, key: "tkt-" + set.status + ":" + row._id + ":" + Date.now() });
  } else if (event === "Escalated") {
    await ns.notify(row.companyId, others([row.ownerUserId, ...(await ns.officeDesk(row.companyId))]), { kind: "escalation", title: "Ticket escalated to " + ESCALATION[set.escalationLevel] + ": " + row.docketNumber, body: tag, link, key: "tkt-esc-manual:" + row._id + ":" + set.escalationLevel });
  }
}

async function patchComplaintsById(ctx) {
  const row = await loadComplaint(ctx);
  const b = ctx.body;
  const desk = isDesk(ctx.user);
  const franchiseUser = FRANCHISE_LAYERS.includes(ctx.user.hierarchy);
  const set = { updatedAt: new Date() };
  const push = [];
  let event = "StatusChanged";

  if (b.action === "remark") {
    const remark = String(b.remark || "").trim();
    if (!remark) return { status: 400, body: { error: "remark required" } };
    push.push(historyEntry(ctx, "Remark", { remark }));
    set.lastAction = "Remark: " + remark.slice(0, 80);
    event = "TicketRemark";
  } else if (b.action === "assign") {
    if (!desk) return { status: 403, body: { error: "service desk only" } };
    if (!can(ctx.user, "Assign", "CRM-05")) return { status: 403, body: { error: "Assign action not granted" } };
    if (row.status === "Closed") return { status: 400, body: { error: "ticket is closed; reopen first" } };
    ["ssm", "rm", "forwardedTo", "ownerName", "ownerNumber", "reportingAuthority"].forEach((k) => b[k] !== undefined && (set[k] = String(b[k])));
    if (set.forwardedTo && set.forwardedTo !== row.forwardedTo) set.forwardedOn = new Date();
    if (b.team !== undefined) set.team = String(b.team).trim();
    if (b.ownerUserId) {
      const u = await repo.users.findOne({ _id: oid(b.ownerUserId), companyId: row.companyId, active: true });
      if (!u || FRANCHISE_LAYERS.includes(u.hierarchy)) return { status: 400, body: { error: "owner must be an active office user of this company" } };
      set.ownerUserId = u._id;
      set.ownerName = u.name;
      set.ownerNumber = set.ownerNumber || u.mobile || "";
    }
    if (b.priority !== undefined && b.priority !== row.priority) {
      if (!PRIORITIES.includes(b.priority)) return { status: 400, body: { error: "unknown priority" } };
      set.priority = b.priority;
    }
    if (b.category && b.category !== row.category) {
      if (!(await taxonomy(row.companyId)).some((c) => c.name === b.category)) return { status: 400, body: { error: "unknown category" } };
      set.category = b.category;
    }
    if (set.priority || set.category) set.dueAt = new Date(new Date(row.createdAt).getTime() + (await slaFor(row.companyId, set.category || row.category, set.priority || row.priority)) * 3600 * 1000);
    if (b.reminderAt !== undefined) set.reminderAt = b.reminderAt ? istDateTime(b.reminderAt) : null;
    if (set.reminderAt && Number.isNaN(set.reminderAt.getTime())) return { status: 400, body: { error: "reminder date/time is not valid" } };
    if (["Open", "Reopened"].includes(row.status)) set.status = "Assigned";
    push.push(historyEntry(ctx, "Assigned", { from: row.status, to: set.status || row.status, remark: [set.ownerName, set.forwardedTo].filter(Boolean).join(" / ") }));
    set.lastAction = "Assigned" + (set.ownerName ? " to " + set.ownerName : "");
    event = "Assigned";
  } else if (b.action === "details") {
    if (!desk) return { status: 403, body: { error: "service desk only" } };
    if (row.status === "Closed") return { status: 400, body: { error: "ticket is closed; reopen first" } };
    const changed = [];
    if (b.flmDone !== undefined) {
      set.flmDone = !!b.flmDone;
      if (set.flmDone && !row.flmDone) set.flmDoneAt = new Date();
      changed.push("FLM " + (set.flmDone ? "done" : "not done"));
    }
    if (b.team !== undefined) {
      const teams = ((await repo.lookups.findOne({ companyId: row.companyId })) || {}).teams || [];
      if (b.team && !teams.includes(b.team)) return { status: 400, body: { error: "team must be one of: " + teams.join(", ") } };
      set.team = String(b.team);
      changed.push("team " + (set.team || "cleared"));
    }
    if (b.category !== undefined && b.category !== row.category) {
      if (!(await taxonomy(row.companyId)).some((c) => c.name === b.category)) return { status: 400, body: { error: "unknown category" } };
      set.category = b.category;
      if (!DONE.includes(row.status)) set.dueAt = new Date(new Date(row.createdAt).getTime() + (await slaFor(row.companyId, b.category, row.priority || "Medium")) * 3600 * 1000);
      changed.push("category " + (row.category || "") + " → " + b.category);
    }
    if (b.outcome !== undefined) {
      set.outcome = String(b.outcome).trim();
      changed.push("outcome " + set.outcome);
    }
    if (b.externalEngineerName !== undefined) {
      set.externalEngineerName = String(b.externalEngineerName).trim().slice(0, 120);
      changed.push("engineer " + (set.externalEngineerName || "cleared"));
    }
    if (b.externalEngineerNumber !== undefined) {
      const n = String(b.externalEngineerNumber).replace(/\s/g, "");
      if (n && !/^\+?\d{10,13}$/.test(n)) return { status: 400, body: { error: "engineer number must be 10–13 digits" } };
      set.externalEngineerNumber = n;
      changed.push("engineer no. " + (n || "cleared"));
    }
    if (b.forwardedOn !== undefined) {
      const d = b.forwardedOn ? istDateTime(b.forwardedOn) : null;
      if (d && Number.isNaN(d.getTime())) return { status: 400, body: { error: "forwarded-on date is not valid" } };
      set.forwardedOn = d;
      changed.push("forwarded on " + (b.forwardedOn || "cleared"));
    }
    if (!changed.length) return { status: 400, body: { error: "nothing to change" } };
    push.push(historyEntry(ctx, "Details", { remark: changed.join("; ") }));
    set.lastAction = changed.join("; ").slice(0, 120);
    event = "TicketUpdated";
  } else if (b.action === "escalate") {
    if (!desk) return { status: 403, body: { error: "service desk only" } };
    if (DONE.includes(row.status)) return { status: 400, body: { error: "ticket is " + row.status } };
    const level = (row.escalationLevel || 0) + 1;
    if (level >= ESCALATION.length) return { status: 400, body: { error: "already escalated to Management" } };
    set.escalationLevel = level;
    set.status = "Escalated";
    push.push(historyEntry(ctx, "Escalated", { from: row.status, to: "Escalated", remark: "to " + ESCALATION[level] + (b.remark ? ": " + b.remark : "") }));
    set.lastAction = "Escalated to " + ESCALATION[level];
    event = "Escalated";
  } else if (b.action === "verify") {
    if (!desk) return { status: 403, body: { error: "service desk only" } };
    if (row.status !== "Resolved") return { status: 400, body: { error: "only a Resolved ticket can be verified" } };
    if (row.verifiedAt) return { status: 400, body: { error: "already verified" } };
    if (row.resolvedBy && String(row.resolvedBy) === String(ctx.user._id)) return { status: 403, body: { error: "the person who resolved the ticket cannot verify it" } };
    const remark = String(b.remark || "").trim();
    if (!remark) return { status: 400, body: { error: "verification remark required (e.g. confirmed with franchisee)" } };
    set.verifiedAt = new Date();
    set.verifiedBy = ctx.user._id;
    set.verifiedByName = ctx.user.name || ctx.user.login;
    push.push(historyEntry(ctx, "Verified", { remark }));
    set.lastAction = "Resolution verified";
    event = "TicketVerified";
  } else if (b.action === "status") {
    const to = String(b.status || "");
    if (!STATUSES.includes(to)) return { status: 400, body: { error: "unknown status" } };
    const remark = String(b.remark || "").trim();
    if (to === "Reopened") {
      if (!DONE.includes(row.status)) return { status: 400, body: { error: "only a Resolved or Closed ticket can be reopened" } };
      if (!remark) return { status: 400, body: { error: "reason required to reopen" } };
      if (!desk && !franchiseUser) return { status: 403, body: { error: "not allowed" } };
      if (await repo.complaints.findOne({ companyId: row.companyId, openKey: row.atmId + "|" + row.problemType, _id: { $ne: row._id } })) {
        return { status: 409, body: { error: "another open complaint exists for this ATM and problem" } };
      }
      set.resolvedAt = null;
      set.closedAt = null;
      set.verifiedAt = null;
      set.openKey = row.atmId + "|" + row.problemType;
      set.dueAt = new Date(Date.now() + (await slaFor(row.companyId, row.category, row.priority || "Medium")) * 3600 * 1000);
    } else if (to === "Closed") {
      if (row.status !== "Resolved") return { status: 400, body: { error: "only a Resolved ticket can be closed" } };
      const closure = String(b.closureRemarks || remark).trim();
      if (!closure) return { status: 400, body: { error: "closure remarks required" } };
      if (!desk && !franchiseUser) return { status: 403, body: { error: "not allowed" } };
      if (desk && !franchiseUser && !can(ctx.user, "Close", "CRM-05")) return { status: 403, body: { error: "Close action not granted" } };
      if (!franchiseUser && !row.verifiedAt && (await serviceSettings(row.companyId)).verifyBeforeClose) return { status: 400, body: { error: "verify the resolution before closing (company setting)" } };
      set.closureRemarks = closure;
      set.closedAt = new Date();
      set.closedBy = ctx.user._id;
      set.redressalDate = row.redressalDate || new Date();
      event = "Closed";
    } else {
      if (!desk) return { status: 403, body: { error: "service desk only" } };
      if (row.status === "Closed") return { status: 400, body: { error: "ticket is closed; reopen first" } };
      if (row.status === "Resolved") return { status: 400, body: { error: "ticket is resolved; close it or reopen with a reason" } };
      if (to === "Resolved") {
        const resolution = String(b.resolution || "").trim();
        if (!resolution) return { status: 400, body: { error: "resolution details required" } };
        set.resolution = resolution;
        set.resolvedAt = new Date();
        set.resolvedBy = ctx.user._id;
        set.verifiedAt = null;
        set.verifiedBy = null;
        set.redressalDate = new Date();
        if (b.outcome !== undefined) set.outcome = String(b.outcome);
      }
    }
    if (to === row.status) return { status: 400, body: { error: "ticket is already " + to } };
    set.status = to;
    if (DONE.includes(to)) set.openKey = null;
    if (to !== "Reopened" && !DONE.includes(row.status) && row.dueAt && new Date() > new Date(row.dueAt) && !row.slaBreachedAt) set.slaBreachedAt = new Date(row.dueAt);
    push.push(historyEntry(ctx, "Status", { from: row.status, to, remark: set.resolution || set.closureRemarks || remark }));
    set.lastAction = to + (remark ? ": " + remark.slice(0, 80) : "");
  } else {
    return { status: 400, body: { error: "action must be remark, assign, details, escalate, verify or status" } };
  }

  await repo.complaints.updateById(row._id, { $set: set, $push: { history: { $each: push } } });
  if (event === "Assigned" && set.ownerUserId && String(set.ownerUserId) !== String(row.ownerUserId)) {
    await notify(row.companyId, [set.ownerUserId], { kind: "assignment", title: "Ticket assigned: " + row.docketNumber, body: row.atmId + " · " + row.problemType, link: { page: "service", id: String(row._id) } });
    if (row.ownerUserId) {
      await repo.tasks.updateMany(
        { companyId: row.companyId, complaintId: row._id, source: "Ticket", assigneeId: row.ownerUserId, status: { $nin: ["Completed", "Closed"] } },
        { $set: { status: "Closed", completedAt: new Date(), updatedAt: new Date() }, $push: { history: { at: new Date(), by: ctx.user._id, byName: ctx.user.name || ctx.user.login, action: "Closed", to: "Closed", remark: "ticket reassigned" } } }
      );
    }
    const t = await ticketTask({ ...row, ...set }, set.ownerUserId, ctx.user);
    if (t) await writeAudit(ctx, "TaskCreated", { companyId: row.companyId, module: "CRM-06", recordId: t._id, work: t.taskNo + " from ticket " + row.docketNumber });
  }
  if (event === "Closed") await closeTicketTasks(row, ctx.user, "ticket " + row.docketNumber + " closed");
  await ticketNotices(ctx, row, set, event).catch(() => {});
  await writeAudit(ctx, event, {
    companyId: row.companyId,
    module: "CRM-05",
    recordId: row._id,
    before: { status: row.status, priority: row.priority, escalationLevel: row.escalationLevel },
    after: set,
    work: row.docketNumber,
  });
  return { status: 200, body: { ok: true } };
}

async function postComplaintsByIdVisits(ctx) {
  const row = await loadComplaint(ctx);
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk assigns visits" } };
  if (!can(ctx.user, "Assign", "CRM-05")) return { status: 403, body: { error: "Assign action not granted" } };
  if (DONE.includes(row.status)) return { status: 400, body: { error: "ticket is " + row.status } };
  const so = await officer(row.companyId, ctx.body.officerId, ["SalesOfficer"]);
  if (!so) return { status: 400, body: { error: "choose an active Sales Officer of this company" } };
  const scheduledAt = istDateTime(ctx.body.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return { status: 400, body: { error: "schedule date/time required" } };
  const open = await repo.visits.findOne({ complaintId: row._id, status: { $in: ["Scheduled", "Rescheduled", "CheckedIn"] } });
  if (open) return { status: 409, body: { error: "a visit is already open on this ticket" } };
  const now = new Date();
  const visit = {
    companyId: row.companyId,
    complaintId: row._id,
    docketNumber: row.docketNumber,
    atmId: row.atmId,
    franchiseId: row.franchiseId,
    officerId: so._id,
    officerName: so.name,
    status: "Scheduled",
    open: true,
    scheduledAt,
    log: [{ at: now, by: ctx.user._id, action: "Scheduled", scheduledAt }],
    checkInAt: null,
    checkOutAt: null,
    atmConfirmed: false,
    findings: "",
    remarks: "",
    outcome: "",
    createdBy: ctx.user._id,
    createdAt: now,
  };
  let result;
  try {
    result = await repo.visits.insert(visit);
  } catch (err) {
    if (err.code !== 11000) throw err;
    return { status: 409, body: { error: "a visit is already open on this ticket" } };
  }
  const to = row.status === "Escalated" ? row.status : "Field Visit Required";
  await repo.complaints.updateById(row._id, {
      $set: { status: to, lastAction: "Visit by " + so.name + " on " + istText(scheduledAt), updatedAt: now },
      $addToSet: { visitOfficerIds: so._id },
      $push: { history: historyEntry(ctx, "Visit assigned", { from: row.status, to, remark: so.name }) },
    });
  await notify(row.companyId, [so._id], { kind: "assignment", title: "Visit assigned: " + row.docketNumber, body: row.atmId + " · " + istText(scheduledAt), link: { page: "service", id: String(result.insertedId), type: "visit" } });
  await writeAudit(ctx, "VisitAssigned", { companyId: row.companyId, module: "CRM-05", recordId: result.insertedId, work: row.docketNumber + " → " + so.name });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function getVisits(ctx) {
  const filter = { companyId: oid(ctx.user.companyId) };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  if (isFieldOnly(ctx.user)) filter.officerId = ctx.user._id;
  else await applyRecordScope(ctx.user, filter, FIELD_OWNERS);
  const visits = await repo.visits.list(filter, { sort: { scheduledAt: -1 }, limit: 300 });
  const complaints = await repo.complaints.list({ _id: { $in: visits.map((v) => v.complaintId) } }, { projection: { history: 0 } });
  const atms = await repo.atms.list({ companyId: filter.companyId, atmId: { $in: visits.map((v) => v.atmId) } }, { projection: { atmId: 1, city: 1, state: 1, siteId: 1, franchiseeName: 1, mobile: 1 } });
  const projects = await repo.site_projects.list({ companyId: filter.companyId, atmId: { $in: visits.map((v) => v.atmId) } }, { projection: { atmId: 1, location: 1, siteLocationName: 1 } });
  const siteIds = [...new Set(atms.map((a) => a.siteId).filter(Boolean))];
  const sites = siteIds.length ? await repo.collection("sites").list({ companyId: filter.companyId, siteId: { $in: siteIds } }, { projection: { siteId: 1, address: 1, city: 1, state: 1, pin: 1, lat: 1, lng: 1 } }) : [];
  return { status: 200, body: {
    visits: visits.map((v) => {
      const c = complaints.find((x) => String(x._id) === String(v.complaintId));
      const p = projects.find((x) => x.atmId === v.atmId);
      const loc = (p && p.location) || {};
      const atm = atms.find((x) => x.atmId === v.atmId) || null;
      const site = atm && atm.siteId ? sites.find((x) => x.siteId === atm.siteId) : null;
      const address = p ? [p.siteLocationName, loc.address, loc.city, loc.pin].filter(Boolean).join(", ") : site ? [site.address, site.city, site.state, site.pin].filter(Boolean).join(", ") : "";
      const gps = site && site.lat && site.lng ? site.lat + "," + site.lng : loc.lat && loc.lng ? loc.lat + "," + loc.lng : "";
      return {
        ...v,
        complaint: c ? decorate(c) : null,
        atm,
        address,
        mapQuery: gps || address || (atm ? [atm.city, atm.state].filter(Boolean).join(", ") : ""),
      };
    }),
  } };
}

// A field entry saved offline and sent later carries the time it was made; accepted up to 48 h back, never ahead.
function offlineAt(ctx, now) {
  const raw = ctx.headers && ctx.headers["x-offline-at"];
  if (!raw) return null;
  const at = new Date(String(raw));
  if (Number.isNaN(at.getTime()) || at > now || now - at > 48 * 3600000) return null;
  return at;
}

async function patchVisitsById(ctx) {
  const v = await repo.visits.findById(oid(ctx.params.id));
  if (!v || !companyScope(ctx.user, v.companyId)) return { status: 404, body: { error: "not found" } };
  const b = ctx.body;
  const now = new Date();
  const madeAt = offlineAt(ctx, now);
  const mine = String(v.officerId) === String(ctx.user._id);
  const desk = isDesk(ctx.user);
  const closed = ["Cancelled", "Submitted"].includes(v.status);
  const set = {};
  const log = { at: now, by: ctx.user._id, action: b.action };
  let event;
  let ticket = null;

  if (b.action === "reschedule" || b.action === "cancel") {
    if (!desk) return { status: 403, body: { error: "service desk only" } };
    if (closed || v.status === "CheckedIn") return { status: 400, body: { error: "visit is " + v.status } };
    const reason = String(b.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "reason required" } };
    log.reason = reason;
    if (b.action === "reschedule") {
      const at = istDateTime(b.scheduledAt);
      if (Number.isNaN(at.getTime())) return { status: 400, body: { error: "new date/time required" } };
      set.scheduledAt = at;
      set.status = "Rescheduled";
      log.scheduledAt = at;
      event = "VisitRescheduled";
    } else {
      set.status = "Cancelled";
      event = "VisitCancelled";
    }
  } else if (["checkIn", "update", "checkOut", "submit"].includes(b.action)) {
    if (!mine) return { status: 403, body: { error: "assigned Sales Officer only" } };
    if (closed) return { status: 400, body: { error: "visit is " + v.status + "; locked" } };
    const gps = b.lat && b.lng ? { lat: String(b.lat), lng: String(b.lng) } : null;
    if (madeAt) {
      log.madeOfflineAt = madeAt;
      set.syncedOffline = true;
    }
    if (b.action === "checkIn") {
      if (v.checkInAt) return { status: 400, body: { error: "already checked in" } };
      set.checkInAt = madeAt || now;
      set.checkInGps = gps;
      set.status = "CheckedIn";
      event = "VisitCheckIn";
    } else {
      if (!v.checkInAt) return { status: 400, body: { error: "check in on site first" } };
      if (b.atmConfirmed !== undefined) {
        if (b.atmConfirmed && String(b.atmIdSeen || "").trim() !== v.atmId) return { status: 400, body: { error: "ATM ID on site does not match " + v.atmId } };
        set.atmConfirmed = !!b.atmConfirmed;
      }
      ["findings", "remarks", "problemIdentified", "actionTaken", "spareRequired", "spareUsed"].forEach((k) => b[k] !== undefined && (set[k] = String(b[k]).slice(0, 2000)));
      if (b.siteStatus !== undefined) {
        if (b.siteStatus && !SITE_STATUSES.includes(b.siteStatus)) return { status: 400, body: { error: "site status must be " + SITE_STATUSES.join(" / ") } };
        set.siteStatus = b.siteStatus || "";
      }
      if (b.action === "checkOut") {
        if (v.checkOutAt) return { status: 400, body: { error: "already checked out" } };
        const out = madeAt && madeAt > new Date(v.checkInAt) ? madeAt : now;
        set.checkOutAt = out;
        set.checkOutGps = gps;
        event = "VisitCheckOut";
      } else if (b.action === "update") {
        event = "VisitUpdated";
      } else {
        const merged = { ...v, ...set };
        if (!merged.checkOutAt) return { status: 400, body: { error: "check out before submitting" } };
        if (!merged.atmConfirmed) return { status: 400, body: { error: "confirm the ATM ID on site" } };
        if (!String(merged.findings || "").trim()) return { status: 400, body: { error: "findings required" } };
        if (!String(merged.actionTaken || "").trim()) return { status: 400, body: { error: "action taken required" } };
        if (!merged.siteStatus) return { status: 400, body: { error: "site status required" } };
        if (!VISIT_OUTCOMES.includes(b.outcome)) return { status: 400, body: { error: "outcome must be " + VISIT_OUTCOMES.join(" / ") } };
        set.outcome = b.outcome;
        set.status = "Submitted";
        set.submittedAt = now;
        event = "VisitSubmitted";
        const to = b.outcome === "Follow-up visit" ? "Field Visit Required" : b.outcome;
        ticket = { to, remark: merged.findings };
      }
    }
    if (gps) log.gps = gps;
  } else {
    return { status: 400, body: { error: "unknown action" } };
  }

  if (["Cancelled", "Submitted"].includes(set.status)) set.open = false;
  await repo.visits.updateById(v._id, { $set: set, $push: { log } });
  if (set.status === "Cancelled") {
    const other = await repo.visits.findOne({ complaintId: v.complaintId, officerId: v.officerId, _id: { $ne: v._id }, status: { $ne: "Cancelled" } });
    if (!other) await repo.complaints.updateById(v.complaintId, { $pull: { visitOfficerIds: v.officerId } });
  }
  if (ticket) {
    const c = await repo.complaints.findById(v.complaintId);
    if (DONE.includes(c.status)) ticket.to = c.status;
    const cset = { status: ticket.to, lastAction: "Visit " + b.outcome + ": " + ticket.remark.slice(0, 80), updatedAt: now };
    if (ticket.to === "Resolved" && c.status !== "Resolved") {
      cset.resolution = ticket.remark;
      cset.resolvedAt = now;
      cset.resolvedBy = ctx.user._id;
      cset.verifiedAt = null;
      cset.redressalDate = now;
      cset.openKey = null;
    }
    if (!DONE.includes(c.status) && c.dueAt && now > new Date(c.dueAt) && !c.slaBreachedAt) cset.slaBreachedAt = new Date(c.dueAt);
    await repo.complaints.updateById(v.complaintId, { $set: cset, $push: { history: historyEntry(ctx, "Visit submitted", { from: c.status, to: ticket.to, remark: ticket.remark }) } });
    await writeAudit(ctx, "StatusChanged", { companyId: v.companyId, module: "CRM-05", recordId: v.complaintId, before: { status: c.status }, after: cset, work: v.docketNumber + " via visit" });
  }
  await writeAudit(ctx, event, { companyId: v.companyId, module: "CRM-05", recordId: v._id, after: set, work: v.docketNumber });
  const ns = require("../notices/notices.service");
  const vlink = { page: "service", id: String(v._id), type: "visit" };
  if (event === "VisitRescheduled" || event === "VisitCancelled") {
    await ns.notify(v.companyId, [v.officerId], { kind: "visit", title: "Visit " + (event === "VisitCancelled" ? "cancelled" : "moved to " + istText(set.scheduledAt)) + ": " + v.docketNumber, body: log.reason, link: vlink, key: "visit-" + b.action + ":" + v._id + ":" + now.getTime() }).catch(() => {});
  } else if (event === "VisitSubmitted") {
    const c = await repo.complaints.findById(v.complaintId, { ownerUserId: 1, franchiseId: 1 });
    const desk = await ns.officeDesk(v.companyId);
    await ns
      .notify(v.companyId, [c && c.ownerUserId, ...desk].filter((x) => x && String(x) !== String(ctx.user._id)), { kind: "visit", title: "Visit report: " + v.docketNumber + " — " + b.outcome, body: String(set.findings || v.findings || "").slice(0, 160), link: { page: "service", id: String(v.complaintId), type: "complaint" }, key: "visit-submitted:" + v._id })
      .catch(() => {});
  }
  return { status: 200, body: { ok: true } };
}

async function getInspections(ctx) {
  const filter = { companyId: oid(ctx.user.companyId) };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  if (isFieldOnly(ctx.user)) filter.officerId = ctx.user._id;
  else await applyRecordScope(ctx.user, filter, FIELD_OWNERS);
  if (ctx.query.atmId) filter.atmId = String(ctx.query.atmId);
  const list = await repo.inspections.list(filter, { sort: { date: -1 }, limit: 500 });
  const files = list.length
    ? await repo.documents.list({ parentType: "inspection", parentId: { $in: list.map((x) => x._id) } }, { projection: { data: 0 } })
    : [];
  return { status: 200, body: { inspections: list.map((x) => ({ ...x, photos: files.filter((d) => String(d.parentId) === String(x._id)) })) } };
}

async function postInspections(ctx) {
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk / Admin assigns inspections" } };
  if (!can(ctx.user, "Assign", "CRM-05")) return { status: 403, body: { error: "Assign action not granted" } };
  const companyId = oid(ctx.user.companyId);
  const f = await findAtm(ctx.user, companyId, ctx.body.atmId);
  if (f.error) return { status: 400, body: { error: f.error } };
  const date = normDate(ctx.body.date);
  if (!date) return { status: 400, body: { error: "date required" } };
  const type = INSPECTION_TYPES.includes(ctx.body.type) ? ctx.body.type : "Routine";
  const u = await officer(companyId, ctx.body.officerId, FIELD_ROLES);
  if (!u) return { status: 400, body: { error: "choose an active Inspector / Sales Officer" } };
  if (await repo.inspections.findOne({ companyId, atmId: f.atm.atmId, date, type })) {
    return { status: 409, body: { error: "inspection already listed for this ATM, date and type" } };
  }
  const doc = {
    companyId,
    atmId: f.atm.atmId,
    atmRef: f.atm._id,
    franchiseId: f.atm.franchiseId || null,
    date,
    type,
    officerId: u._id,
    officerName: u.name,
    status: "Assigned",
    checklist: blankChecklist(await checklistTemplate(companyId)),
    source: "screen",
    createdBy: ctx.user._id,
    createdAt: new Date(),
  };
  const result = await repo.inspections.insert(doc);
  await notify(companyId, [u._id], { kind: "assignment", title: "Inspection assigned: " + doc.atmId, body: doc.type + " on " + date, link: { page: "service", id: String(result.insertedId), type: "inspection" } });
  await writeAudit(ctx, "InspectionAssigned", { companyId, module: "CRM-05", recordId: result.insertedId, work: doc.atmId + " " + date + " → " + u.name });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchInspectionsById(ctx) {
  const x = await repo.inspections.findById(oid(ctx.params.id));
  if (!x || !companyScope(ctx.user, x.companyId)) return { status: 404, body: { error: "not found" } };
  const b = ctx.body;
  const now = new Date();
  const mine = String(x.officerId) === String(ctx.user._id);
  const set = { updatedAt: now };
  let event;

  if (["checkIn", "save", "submit"].includes(b.action)) {
    if (!mine && !isAdmin(ctx.user)) return { status: 403, body: { error: "assigned officer only" } };
    if (x.status !== "Assigned") return { status: 400, body: { error: "inspection is " + x.status + "; locked" } };
    const gps = b.lat && b.lng ? { lat: String(b.lat), lng: String(b.lng) } : null;
    if (b.action === "checkIn") {
      if (x.checkInAt) return { status: 400, body: { error: "already checked in" } };
      set.checkInAt = now;
      set.gps = gps;
      event = "InspectionCheckIn";
    } else {
      if (Array.isArray(b.checklist)) {
        set.checklist = (x.checklist || []).map((base) => {
          const answer = base.answer || "passfail";
          const hit = b.checklist.find((c) => c.item === base.item) || {};
          const result = ANSWERS[answer].includes(String(hit.result)) ? String(hit.result) : "";
          return { ...base, answer, result, remark: String(hit.remark || "") };
        });
      }
      if (b.remarks !== undefined) set.remarks = String(b.remarks);
      event = "InspectionSaved";
      if (b.action === "submit") {
        if (!x.checkInAt) return { status: 400, body: { error: "check in on site first" } };
        const list = set.checklist || x.checklist;
        const missing = list.filter((c) => !c.result).map((c) => c.item);
        if (missing.length) return { status: 400, body: { error: "checklist incomplete: " + missing.join(", ") } };
        if (list.some((c) => itemFailed(c) && !c.remark.trim())) return { status: 400, body: { error: "remark required for each failed item" } };
        const docs = await repo.documents.list({ parentType: "inspection", parentId: x._id, uploadedBy: { $in: [x.officerId, ctx.user._id] } }, { projection: { type: 1 } });
        if (!docs.length) return { status: 400, body: { error: "upload at least one photo" } };
        const noPhoto = list.filter((c) => c.photo && c.result !== "NA" && !docs.some((d) => d.type === "Item photo: " + c.item)).map((c) => c.item);
        if (noPhoto.length) return { status: 400, body: { error: "photo required for: " + noPhoto.join(", ") } };
        set.result = list.some(itemFailed) ? "Fail" : "Pass";
        set.failedItems = list.filter(itemFailed).map((c) => c.item);
        set.checkOutAt = now;
        if (gps) set.checkOutGps = gps;
        set.status = "Submitted";
        set.submittedAt = now;
        event = "InspectionSubmitted";
      }
    }
  } else if (b.action === "verify" || b.action === "reject") {
    if (!canApproveApplication(ctx.user) || isFieldOnly(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
    if (mine) return { status: 403, body: { error: "the inspecting officer cannot verify own inspection" } };
    if (x.status !== "Submitted") return { status: 400, body: { error: "only a Submitted inspection can be verified" } };
    if (b.action === "verify") {
      set.status = "Verified";
      set.verifiedBy = ctx.user._id;
      set.verifiedAt = now;
      event = "InspectionVerified";
    } else {
      const reason = String(b.reason || "").trim();
      if (!reason) return { status: 400, body: { error: "reason required" } };
      set.status = "Assigned";
      set.rejectReason = reason;
      set.checkOutAt = null;
      event = "InspectionReturned";
    }
  } else {
    return { status: 400, body: { error: "unknown action" } };
  }

  await repo.inspections.updateById(x._id, { $set: set });
  await writeAudit(ctx, event, { companyId: x.companyId, module: "CRM-05", recordId: x._id, before: { status: x.status }, after: set, work: x.atmId + " " + x.date });
  const ns = require("../notices/notices.service");
  const ilink = { page: "service", id: String(x._id), type: "inspection" };
  if (event === "InspectionSubmitted") {
    const checkers = (await repo.users.list({ companyId: x.companyId, active: true })).filter((u) => canApproveApplication(u) && !isFieldOnly(u) && String(u._id) !== String(x.officerId)).map((u) => u._id);
    await ns.notify(x.companyId, checkers, { kind: "inspection", title: "Inspection to verify: " + x.atmId + " (" + set.result + ")", body: x.type + " on " + x.date + " by " + x.officerName, link: ilink, key: "insp-submitted:" + x._id + ":" + now.getTime() }).catch(() => {});
  } else if (event === "InspectionVerified" || event === "InspectionReturned") {
    await ns.notify(x.companyId, [x.officerId], { kind: "inspection", title: "Inspection " + (event === "InspectionVerified" ? "verified" : "returned — redo") + ": " + x.atmId, body: set.rejectReason || x.type + " on " + x.date, link: ilink, key: "insp-" + b.action + ":" + x._id + ":" + now.getTime() }).catch(() => {});
  }
  if (event === "InspectionVerified" && x.result === "Fail" && !x.correctiveTaskId) {
    const follow = await failedInspectionFollowUp(ctx, x);
    return { status: 200, body: { ok: true, ...follow } };
  }
  return { status: 200, body: { ok: true } };
}

// A verified failed inspection opens a corrective task, schedules a re-inspection in 7 days and tells franchise + desk.
async function failedInspectionFollowUp(ctx, x) {
  const ns = require("../notices/notices.service");
  const { createTask } = require("../tasks/tasks.service");
  const items = (x.checklist || []).filter(itemFailed);
  const detail = items.map((c) => "• " + c.item + ": " + c.result + (c.remark ? " — " + c.remark : "")).join("\n");
  const r = await createTask(
    x.companyId,
    ctx.user,
    { title: "Corrective action: ATM " + x.atmId + " failed " + x.type + " inspection", description: "Inspection on " + x.date + " by " + x.officerName + "\n" + detail, source: "Inspection", type: "Service", subType: "Inspection", category: "Field", priority: "High", atmId: x.atmId, franchiseId: x.franchiseId ? String(x.franchiseId) : undefined, managerId: String(ctx.user._id), dueAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString() },
    { allowPastDue: true }
  );
  const reDate = shiftDate(istToday(), 7);
  let reId = null;
  const exists = await repo.inspections.findOne({ companyId: x.companyId, atmId: x.atmId, date: reDate, type: "Re-inspection" });
  if (!exists) {
    const ins = await repo.inspections.insert({
      companyId: x.companyId,
      atmId: x.atmId,
      atmRef: x.atmRef,
      franchiseId: x.franchiseId || null,
      date: reDate,
      type: "Re-inspection",
      officerId: x.officerId,
      officerName: x.officerName,
      status: "Assigned",
      checklist: blankChecklist(await checklistTemplate(x.companyId)),
      source: "re-inspection",
      reinspectionOf: x._id,
      createdBy: ctx.user._id,
      createdAt: new Date(),
    });
    reId = ins.insertedId;
    await ns.notify(x.companyId, [x.officerId], { kind: "assignment", title: "Re-inspection assigned: " + x.atmId, body: "On " + reDate + " after failed " + x.type + " inspection", link: { page: "service", id: String(reId), type: "inspection" } }).catch(() => {});
  } else reId = exists._id;
  await repo.inspections.updateById(x._id, { $set: { correctiveTaskId: r.task ? r.task._id : null, correctiveTaskNo: r.task ? r.task.taskNo : "", reinspectionId: reId } });
  const failedText = items.map((c) => c.item).join(", ");
  await ns.notify(x.companyId, await ns.officeDesk(x.companyId), { kind: "inspection", title: "Inspection failed: ATM " + x.atmId, body: failedText + (r.task ? " · task " + r.task.taskNo : ""), link: { page: "service", id: String(x._id), type: "inspection" }, key: "insp-failed:" + x._id }).catch(() => {});
  if (x.franchiseId) await ns.notifyFranchise(x.companyId, x.franchiseId, { kind: "inspection", title: "Inspection failed: ATM " + x.atmId, body: "Please fix: " + failedText + ". Re-inspection on " + reDate + ".", link: { page: "service", id: String(x._id), type: "inspection" }, key: "insp-failed-fr:" + x._id }).catch(() => {});
  await writeAudit(ctx, "InspectionFailedFollowUp", { companyId: x.companyId, module: "CRM-05", recordId: x._id, work: x.atmId + " → " + (r.task ? r.task.taskNo : "no task (" + (r.error || "") + ")") + ", re-inspection " + reDate });
  return { correctiveTaskNo: r.task ? r.task.taskNo : "", reinspectionDate: reDate };
}

async function getServiceAtmHistoryByAtmId(ctx) {
  const companyId = oid(ctx.user.companyId);
  const f = await findAtm(ctx.user, companyId, ctx.params.atmId);
  if (f.error) return { status: 400, body: { error: f.error } };
  if (isFieldOnly(ctx.user)) return { status: 403, body: { error: "service desk only" } };
  const atmId = f.atm.atmId;
  const [complaints, visits, inspections] = await Promise.all([
    repo.complaints.list({ companyId, atmId }, { projection: { history: 0 }, sort: { createdAt: -1 } }),
    repo.visits.list({ companyId, atmId }, { sort: { createdAt: -1 } }),
    repo.inspections.list({ companyId, atmId }, { sort: { date: -1 } }),
  ]);
  return { status: 200, body: { atm: { atmId, city: f.atm.city, cashLiveDate: f.atm.cashLiveDate }, complaints: complaints.map(decorate), visits, inspections } };
}

async function canViewComplaint(user, row) {
  if (!row || !companyScope(user, row.companyId)) return false;
  if (!(await inFranchiseScope(user, row.franchiseId))) return false;
  if (isFieldOnly(user) && !(row.visitOfficerIds || []).some((x) => String(x) === String(user._id))) return false;
  return true;
}

module.exports = { isFieldOnly, isDesk, ageBucket, decorate, slaHours, taxonomy, slaFor, serviceSettings, mappedOwners, sweepComplaints, ticketTask, closeTicketTasks, nextDocket, istDateTime, istText, historyEntry, findAtm, officer, complaintFilter, inComplaintScope, loadComplaint, saveInspectionRow, createComplaint, ticketFromMail, canViewComplaint, getServiceMeta, getServiceBoard, patchServiceSla, patchServiceSettings, getServiceOfficers, getComplaints, getComplaintsById, postComplaints, getComplaintsExport, patchComplaintsById, postComplaintsByIdVisits, getVisits, patchVisitsById, getInspections, postInspections, patchInspectionsById, getServiceAtmHistoryByAtmId };
