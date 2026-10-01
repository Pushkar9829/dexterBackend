const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const { endSessionLog } = require("../audit/audit.service");
const { EMPLOYMENT_STATUSES, skillList } = require("./employees.model");
const repo = require("./employees.repository");
const { CREATABLE_LAYERS } = require("../users/users.model");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

// Same rule as user editing: an employee record can only be tied to (and so lock out) a login the editor may manage.
function canManageLogin(editor, user) {
  if (String(user._id) === String(editor._id)) return false;
  return (CREATABLE_LAYERS[editor.hierarchy] || []).includes(user.hierarchy);
}

async function getEmployees(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user) && ctx.user.hierarchy !== "Director") return { status: 403, body: { error: "office Admin only" } };
  const list = await repo.employees.list({ companyId }, { sort: { name: 1 } });
  return { status: 200, body: { employees: list, statuses: EMPLOYMENT_STATUSES } };
}

async function postEmployees(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "office Admin only" } };
  const doc = {
    companyId,
    name: String(ctx.body.name || "").trim(),
    department: String(ctx.body.department || ""),
    designation: String(ctx.body.designation || ""),
    reportingManager: String(ctx.body.reportingManager || ""),
    employmentStatus: String(ctx.body.employmentStatus || "Active"),
    hrmsEmployeeId: String(ctx.body.hrmsEmployeeId || "").trim(),
    region: String(ctx.body.region || "").trim(),
    team: String(ctx.body.team || "").trim(),
    location: String(ctx.body.location || "").trim(),
    skills: skillList(ctx.body.skills),
    statusReason: String(ctx.body.statusReason || "").trim(),
    userId: null,
    createdAt: new Date(),
  };
  if (!doc.name) return { status: 400, body: { error: "name required" } };
  if (!EMPLOYMENT_STATUSES.includes(doc.employmentStatus)) return { status: 400, body: { error: "status must be " + EMPLOYMENT_STATUSES.join(" / ") } };
  if (ctx.body.userId) {
    const u = await repo.users.findOne({ _id: oid(ctx.body.userId), companyId });
    if (!u) return { status: 400, body: { error: "login not in this company" } };
    if (!canManageLogin(ctx.user, u)) return { status: 403, body: { error: "you cannot link a " + u.hierarchy + " login" } };
    const taken = await repo.employees.findOne({ userId: u._id });
    if (taken) return { status: 409, body: { error: "login " + u.login + " is already linked to employee " + taken.name } };
    doc.userId = u._id;
  }
  const result = await repo.employees.insert(doc);
  await writeAudit(ctx, "EmployeeCreated", { companyId, module: "CRM-01", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchEmployeesById(ctx) {
  const row = await repo.employees.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const set = {};
  ["name", "department", "designation", "reportingManager", "hrmsEmployeeId", "region", "team", "location", "statusReason"].forEach((k) => ctx.body[k] !== undefined && (set[k] = String(ctx.body[k]).trim()));
  if (ctx.body.skills !== undefined) set.skills = skillList(ctx.body.skills);
  if (ctx.body.employmentStatus !== undefined) {
    if (!EMPLOYMENT_STATUSES.includes(ctx.body.employmentStatus)) return { status: 400, body: { error: "status must be " + EMPLOYMENT_STATUSES.join(" / ") } };
    set.employmentStatus = ctx.body.employmentStatus;
    if (set.employmentStatus !== row.employmentStatus) set.statusAt = new Date();
  }
  if (ctx.body.userId !== undefined) {
    const u = ctx.body.userId ? await repo.users.findOne({ _id: oid(ctx.body.userId), companyId: row.companyId }) : null;
    if (ctx.body.userId && !u) return { status: 400, body: { error: "login not in this company" } };
    if (u && !canManageLogin(ctx.user, u)) return { status: 403, body: { error: "you cannot link a " + u.hierarchy + " login" } };
    if (u) {
      const taken = await repo.employees.findOne({ userId: u._id, _id: { $ne: row._id } });
      if (taken) return { status: 409, body: { error: "login " + u.login + " is already linked to employee " + taken.name } };
    }
    set.userId = u ? u._id : null;
  }
  const linkedId = set.userId !== undefined ? set.userId : row.userId;
  if (set.employmentStatus && set.employmentStatus !== row.employmentStatus && linkedId) {
    const linked = await repo.users.findById(linkedId);
    if (linked && !canManageLogin(ctx.user, linked)) return { status: 403, body: { error: "this employee's login is a " + linked.hierarchy + "; you cannot change its status" } };
  }
  if (set.name === "") return { status: 400, body: { error: "name required" } };
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.employees.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  let tasks = null;
  if (set.employmentStatus && set.employmentStatus !== "Active" && (set.userId || row.userId)) {
    await repo.sessions.deleteMany({ userId: set.userId || row.userId });
    await endSessionLog({ userId: set.userId || row.userId }, "Revoked");
    if (set.employmentStatus !== "On Leave") tasks = await require("../tasks/tasks.service").reassignFromInactive(ctx, row.companyId, set.userId || row.userId, (set.name || row.name) + " is " + set.employmentStatus);
  }
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "EmployeeUpdated", { companyId: row.companyId, module: "CRM-01", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true, ...(tasks ? { tasksMoved: tasks.moved, tasksLeft: tasks.left } : {}) } };
}

module.exports = { getEmployees, postEmployees, patchEmployeesById };
