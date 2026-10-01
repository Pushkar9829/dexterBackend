const { isOfficeAdmin, companyScope } = require("../../middlewares/rbac");
const { TASK_DONE } = require("./teams.model");
const repo = require("./teams.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS } = require("../../utils/scope");

const lower = (s) => String(s || "").trim().toLowerCase();

// Team name -> lead user id (string), from the Team register.
async function teamLeadMap(companyId) {
  const rows = await repo.teams.list({ companyId, active: { $ne: false }, leadId: { $ne: null } }, { projection: { name: 1, leadId: 1 } });
  return Object.fromEntries(rows.map((t) => [t.name, String(t.leadId)]));
}

async function syncLookupNames(companyId) {
  const [docs, lu] = await Promise.all([repo.teams.list({ companyId }, { projection: { name: 1, active: 1 } }), repo.lookups.findOne({ companyId }, { projection: { teams: 1 } })]);
  const inactive = new Set(docs.filter((d) => d.active === false).map((d) => lower(d.name)));
  const names = [...new Set([...((lu && lu.teams) || []), ...docs.filter((d) => d.active !== false).map((d) => d.name)])].filter((n) => n && !inactive.has(lower(n)));
  await repo.lookups.updateOne({ companyId }, { $set: { teams: names.sort((a, b) => a.localeCompare(b)) } }, { upsert: true });
}

async function checkLead(companyId, leadId) {
  if (!leadId) return { lead: null };
  const u = await repo.users.findOne({ _id: oid(leadId), companyId, active: true }, { projection: { name: 1, hierarchy: 1 } });
  if (!u || FRANCHISE_LAYERS.includes(u.hierarchy)) return { error: "team lead must be an active office user of this company" };
  return { lead: u };
}

function canManage(user) {
  return isOfficeAdmin(user);
}

async function getTeams(ctx) {
  const companyId = oid(ctx.user.companyId);
  if (!companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user) && ctx.user.hierarchy !== "Director") return { status: 403, body: { error: "office Admin only" } };
  const [docs, lu, users, emps, open] = await Promise.all([
    repo.teams.list({ companyId }, { sort: { name: 1 } }),
    repo.lookups.findOne({ companyId }, { projection: { teams: 1, taskTeamLeads: 1 } }),
    repo.users.list({ companyId, active: true }, { projection: { name: 1, login: 1, hierarchy: 1, functionalRole: 1, team: 1, taskProfile: 1 } }),
    repo.employees.list({ companyId }, { projection: { name: 1, team: 1, userId: 1, employmentStatus: 1 } }),
    repo.tasks.aggregate([{ $match: { companyId, status: { $nin: TASK_DONE }, team: { $nin: [null, ""] } } }, { $group: { _id: "$team", n: { $sum: 1 }, overdue: { $sum: { $cond: [{ $lt: ["$dueAt", new Date()] }, 1, 0] } } } }]).toArray(),
  ]);
  const openBy = new Map(open.map((o) => [o._id, o]));
  const legacyLeads = (lu && lu.taskTeamLeads) || {};
  const known = new Set(docs.map((d) => lower(d.name)));
  const virtual = ((lu && lu.teams) || []).filter((n) => n && !known.has(lower(n))).map((name) => ({ _id: null, name, department: "", description: "", leadId: legacyLeads[name] || null, active: true, unsaved: true }));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  const rows = [...docs, ...virtual].map((t) => {
    const members = users.filter((u) => u.team === t.name || (u.taskProfile && u.taskProfile.team === t.name)).map((u) => ({ _id: u._id, name: u.name, login: u.login, role: u.functionalRole || u.hierarchy }));
    const employees = emps.filter((e) => e.team === t.name).length;
    const o = openBy.get(t.name) || { n: 0, overdue: 0 };
    return { ...t, leadName: t.leadId ? userName.get(String(t.leadId)) || t.leadName || "" : "", members, employees, openTasks: o.n, overdueTasks: o.overdue };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { status: 200, body: {
    teams: rows,
    users: users.filter((u) => !FRANCHISE_LAYERS.includes(u.hierarchy)).map((u) => ({ _id: u._id, name: u.name, login: u.login, team: u.team || "", taskTeam: (u.taskProfile && u.taskProfile.team) || "" })),
    departments: [...new Set(docs.map((d) => d.department).filter(Boolean))].sort(),
    canManage: canManage(ctx.user),
  } };
}

async function setMembers(companyId, name, add, remove) {
  const addIds = (add || []).map(oid).filter(Boolean);
  const removeIds = (remove || []).map(oid).filter(Boolean);
  if (addIds.length) {
    const ok = await repo.users.count({ _id: { $in: addIds }, companyId, hierarchy: { $nin: FRANCHISE_LAYERS } });
    if (ok !== addIds.length) return { error: "members must be office users of this company" };
    await repo.users.updateMany({ _id: { $in: addIds } }, { $set: { team: name, "taskProfile.team": name } });
  }
  if (removeIds.length) {
    await repo.users.updateMany({ _id: { $in: removeIds }, team: name }, { $set: { team: "" } });
    await repo.users.updateMany({ _id: { $in: removeIds }, "taskProfile.team": name }, { $set: { "taskProfile.team": "" } });
  }
  return { added: addIds.length, removed: removeIds.length };
}

async function postTeams(ctx) {
  if (!canManage(ctx.user)) return { status: 403, body: { error: "office Admin / HR only" } };
  const companyId = oid(ctx.user.companyId);
  const b = ctx.body || {};
  const name = String(b.name || "").trim().slice(0, 60);
  if (name.length < 2) return { status: 400, body: { error: "team name needs 2+ characters" } };
  const clash = await repo.teams.findOne({ companyId, name: { $regex: "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", $options: "i" } });
  if (clash) return { status: 409, body: { error: "a team called " + clash.name + " already exists" } };
  const l = await checkLead(companyId, b.leadId);
  if (l.error) return { status: 400, body: { error: l.error } };
  const doc = { companyId, name, department: String(b.department || "").trim().slice(0, 60), description: String(b.description || "").trim().slice(0, 300), leadId: l.lead ? l.lead._id : null, leadName: l.lead ? l.lead.name : "", active: true, createdBy: ctx.user._id, createdAt: new Date(), updatedAt: new Date() };
  const r = await repo.teams.insert(doc);
  const m = await setMembers(companyId, name, b.addMembers, []);
  if (m.error) return { status: 400, body: { error: m.error } };
  await syncLookupNames(companyId);
  await writeAudit(ctx, "TeamCreated", { companyId, module: "CRM-01", recordId: r.insertedId, after: { name, department: doc.department, lead: doc.leadName } });
  return { status: 200, body: { id: String(r.insertedId) } };
}

async function patchTeamsById(ctx) {
  if (!canManage(ctx.user)) return { status: 403, body: { error: "office Admin / HR only" } };
  const row = await repo.teams.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const companyId = row.companyId;
  const b = ctx.body || {};
  const set = {};
  if (b.name !== undefined) {
    const name = String(b.name || "").trim().slice(0, 60);
    if (name.length < 2) return { status: 400, body: { error: "team name needs 2+ characters" } };
    if (name !== row.name) {
      const clash = await repo.teams.findOne({ companyId, _id: { $ne: row._id }, name: { $regex: "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", $options: "i" } });
      if (clash) return { status: 409, body: { error: "a team called " + clash.name + " already exists" } };
      set.name = name;
    }
  }
  if (b.department !== undefined) set.department = String(b.department || "").trim().slice(0, 60);
  if (b.description !== undefined) set.description = String(b.description || "").trim().slice(0, 300);
  if (b.leadId !== undefined) {
    const l = await checkLead(companyId, b.leadId);
    if (l.error) return { status: 400, body: { error: l.error } };
    set.leadId = l.lead ? l.lead._id : null;
    set.leadName = l.lead ? l.lead.name : "";
  }
  if (b.active !== undefined) set.active = b.active !== false && b.active !== "false";
  const name = set.name || row.name;
  if (Object.keys(set).length) {
    set.updatedAt = new Date();
    await repo.teams.updateById(row._id, { $set: set });
  }
  if (set.name) {
    await repo.users.updateMany({ companyId, team: row.name }, { $set: { team: name } });
    await repo.users.updateMany({ companyId, "taskProfile.team": row.name }, { $set: { "taskProfile.team": name } });
    await repo.employees.updateMany({ companyId, team: row.name }, { $set: { team: name } });
    await repo.tasks.updateMany({ companyId, team: row.name, status: { $nin: TASK_DONE } }, { $set: { team: name } });
    await repo.lookups.updateOne({ companyId }, { $pull: { teams: row.name } });
  }
  const m = await setMembers(companyId, name, b.addMembers, b.removeMembers);
  if (m.error) return { status: 400, body: { error: m.error } };
  if (set.name || set.active !== undefined) await syncLookupNames(companyId);
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "TeamChanged", { companyId, module: "CRM-01", recordId: row._id, before, after: { ...set, added: m.added, removed: m.removed }, work: name });
  return { status: 200, body: { ok: true, ...m } };
}

module.exports = { teamLeadMap, getTeams, postTeams, patchTeamsById };
