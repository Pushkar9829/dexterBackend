const { ROLE_ACTIONS, companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const { endSessionLog } = require("../audit/audit.service");
const { FUNCTIONAL_ROLES, OFFICE_ONLY_ROLES, CREATABLE_LAYERS, ALL_ACTIONS, RECORD_SCOPES, MODULE_CODES, ROLE_PRESETS, toPublic } = require("./users.model");
const repo = require("./users.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { passwordProblem, hashPassword } = require("../../utils/password");
const { FRANCHISE_LAYERS, byProject } = require("../../utils/scope");

function idList(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 500);
}

function effectiveActions(u) {
  return u.actions && u.actions.length ? u.actions : ROLE_ACTIONS[u.hierarchy] || [];
}

// actions / modules are undefined when unchanged. An empty actions list means the layer's defaults, so those are what
// get compared against the editor's own actions.
function checkGrantable(editor, actions, modules, targetLayer) {
  if (actions) {
    const mine = effectiveActions(editor);
    const extra = effectiveActions({ hierarchy: targetLayer, actions }).filter((a) => !mine.includes(a));
    if (extra.length) return "you cannot grant actions you do not have: " + extra.join(", ");
  }
  if (editor.modules && editor.modules.length && modules) {
    if (!modules.length) return "you cannot grant all modules; pick from your own";
    const extra = modules.filter((m) => !editor.modules.includes(m));
    if (extra.length) return "you cannot grant modules you do not have: " + extra.join(", ");
  }
  return "";
}

function checkRoleForLayer(hierarchy, role) {
  if (role && !FUNCTIONAL_ROLES.includes(role)) return "unknown functional role";
  if (FRANCHISE_LAYERS.includes(hierarchy) && OFFICE_ONLY_ROLES.includes(role)) return "franchise-network users cannot hold the " + role + " role";
  return "";
}

// A project-scoped editor can only hand out their own projects; an empty list means every project, so they cannot give that.
function projectsWithin(editor, ids) {
  if (!byProject(editor)) return "";
  const mine = editor.projectIds.map(String);
  if (!ids.length) return "pick projects from your own; you cannot grant all projects";
  const extra = ids.filter((id) => !mine.includes(String(id)));
  return extra.length ? "you cannot grant projects you do not hold" : "";
}

function textList(v, max) {
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
}

async function roleTemplates(companyId) {
  const lu = (await repo.lookups.findOne({ companyId }, { projection: { roleTemplates: 1 } })) || {};
  const custom = (Array.isArray(lu.roleTemplates) ? lu.roleTemplates : []).map((t) => ({ ...t, builtIn: false }));
  return [...ROLE_PRESETS.map((t) => ({ ...t, builtIn: true })), ...custom];
}

function cleanTemplate(t) {
  const name = String((t && t.name) || "").trim().slice(0, 60);
  if (!name) return { error: "every template needs a name" };
  const hierarchy = String(t.hierarchy || "");
  if (!["DexterIndiaCompanyTeam", "Director", "Admin", "SubAdmin", ...FRANCHISE_LAYERS].includes(hierarchy)) return { error: name + ": unknown hierarchy" };
  const functionalRole = String(t.functionalRole || "");
  const roleErr = checkRoleForLayer(hierarchy, functionalRole);
  if (roleErr) return { error: name + ": " + roleErr };
  const actions = textList(t.actions, 20);
  if (actions.some((a) => !ALL_ACTIONS.includes(a))) return { error: name + ": unknown action" };
  const modules = textList(t.modules, 20);
  if (modules.some((m) => !MODULE_CODES.includes(m))) return { error: name + ": unknown module" };
  const recordScope = RECORD_SCOPES.includes(t.recordScope) ? t.recordScope : "all";
  const key = String(t.key || "").trim() || "c-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { tpl: { key, name, description: String(t.description || "").trim().slice(0, 200), hierarchy, functionalRole, actions, modules, recordScope } };
}

async function getRoleTemplates(ctx) {
  const companyId = oid(ctx.user.companyId);
  if (!isOfficeAdmin(ctx.user) && ctx.user.hierarchy !== "Director") return { status: 403, body: { error: "office Admin only" } };
  const [templates, used] = await Promise.all([
    roleTemplates(companyId),
    repo.users.aggregate([{ $match: { companyId, roleTemplate: { $nin: [null, ""] } } }, { $group: { _id: "$roleTemplate", n: { $sum: 1 } } }]).toArray(),
  ]);
  const usedBy = new Map(used.map((u) => [u._id, u.n]));
  return { status: 200, body: {
    templates: templates.map((t) => ({ ...t, users: usedBy.get(t.key) || 0 })),
    roles: FUNCTIONAL_ROLES,
    modules: MODULE_CODES,
    actions: ALL_ACTIONS,
    canEdit: ["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy),
  } };
}

// Replaces the company's custom templates; built-in presets are fixed.
async function putRoleTemplates(ctx) {
  if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "only Admin edits role templates" } };
  const companyId = oid(ctx.user.companyId);
  const rows = Array.isArray(ctx.body.templates) ? ctx.body.templates : [];
  const out = [];
  for (const r of rows.slice(0, 40)) {
    const c = cleanTemplate(r);
    if (c.error) return { status: 400, body: { error: c.error } };
    if (ROLE_PRESETS.some((p) => p.key === c.tpl.key || p.name.toLowerCase() === c.tpl.name.toLowerCase())) return { status: 400, body: { error: c.tpl.name + " clashes with a built-in template" } };
    if (out.some((x) => x.key === c.tpl.key || x.name.toLowerCase() === c.tpl.name.toLowerCase())) return { status: 400, body: { error: "template listed twice: " + c.tpl.name } };
    out.push(c.tpl);
  }
  const before = ((await repo.lookups.findOne({ companyId }, { projection: { roleTemplates: 1 } })) || {}).roleTemplates || [];
  const dropped = before.filter((b) => !out.some((x) => x.key === b.key)).map((b) => b.key);
  if (dropped.length && (await repo.users.count({ companyId, roleTemplate: { $in: dropped } }))) return { status: 400, body: { error: "users still carry a template you removed; move them to another template first" } };
  await repo.lookups.updateOne({ companyId }, { $set: { roleTemplates: out } }, { upsert: true });
  await writeAudit(ctx, "RoleTemplatesChanged", { companyId, module: "CRM-01", before: before.map((b) => b.name), after: out.map((b) => b.name) });
  return { status: 200, body: { ok: true } };
}

async function templateKey(companyId, key) {
  const k = String(key || "").trim();
  if (!k) return { key: "" };
  return (await roleTemplates(companyId)).some((t) => t.key === k) ? { key: k } : { error: "unknown role template" };
}

function grantsWithin(editor, ids) {
  const mine = editor.grantedCompanyIds && editor.grantedCompanyIds.length ? editor.grantedCompanyIds : [editor.homeCompanyId || editor.companyId];
  return ids.length > 0 && ids.every((id) => mine.some((m) => String(m) === String(id)));
}

async function getUsers(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user) && ctx.user.hierarchy !== "Director") return { status: 403, body: { error: "office Admin only" } };
  const list = await repo.users.list({ companyId }, { projection: { passwordHash: 0, passwordSalt: 0, totpSecret: 0, totpPending: 0 }, sort: { name: 1 } });
  const [emps, logins] = await Promise.all([
    repo.employees.list({ companyId, userId: { $ne: null } }, { projection: { userId: 1, employmentStatus: 1, name: 1 } }),
    repo.session_log.aggregate([{ $match: { companyId } }, { $group: { _id: "$userId", last: { $max: "$startAt" } } }]).toArray(),
  ]);
  const empBy = new Map(emps.map((e) => [String(e.userId), e]));
  const lastBy = new Map(logins.map((l) => [String(l._id), l.last]));
  return { status: 200, body: { users: list.map((u) => {
    const e = empBy.get(String(u._id));
    return { ...toPublic(u), employeeId: e ? String(e._id) : null, employmentStatus: e ? e.employmentStatus || "" : null, lastLoginAt: lastBy.get(String(u._id)) || null };
  }) } };
}

async function postUsers(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "office Admin only" } };
  const login = String(ctx.body.login || "").trim().toLowerCase();
  const password = String(ctx.body.password || "");
  const name = String(ctx.body.name || "").trim();
  const hierarchy = String(ctx.body.hierarchy || "Franchise");
  if (!login || !password || !name) return { status: 400, body: { error: "login, password, name required" } };
  if (!(CREATABLE_LAYERS[ctx.user.hierarchy] || []).includes(hierarchy)) {
    return { status: 403, body: { error: "you cannot create a " + hierarchy + " user" } };
  }
  if (FRANCHISE_LAYERS.includes(hierarchy)) {
    const node = ctx.body.franchiseId ? await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId }) : null;
    if (!node) return { status: 400, body: { error: "franchise-network user needs a franchise node in this company" } };
    if (node.layer && node.layer !== hierarchy) return { status: 400, body: { error: "a " + hierarchy + " user needs a " + hierarchy + " node (this node is " + node.layer + ")" } };
  }
  const projectIds = (ctx.body.projectIds || []).map(oid).filter(Boolean);
  if (projectIds.length && (await repo.projects.count({ _id: { $in: projectIds }, companyId })) !== projectIds.length) {
    return { status: 400, body: { error: "projects must belong to this company" } };
  }
  const projErr = projectsWithin(ctx.user, projectIds);
  if (projErr) return { status: 403, body: { error: projErr } };
  const weak = passwordProblem(password);
  if (weak) return { status: 400, body: { error: weak } };
  const functionalRole = String(ctx.body.functionalRole || "");
  const roleErr = checkRoleForLayer(hierarchy, functionalRole);
  if (roleErr) return { status: 400, body: { error: roleErr } };
  const actions = Array.isArray(ctx.body.actions) ? ctx.body.actions.map(String) : [];
  const modules = Array.isArray(ctx.body.modules) ? ctx.body.modules.map(String) : [];
  if (actions.some((a) => !ALL_ACTIONS.includes(a))) return { status: 400, body: { error: "unknown action" } };
  const grantErr = checkGrantable(ctx.user, actions, modules, hierarchy);
  if (grantErr) return { status: 403, body: { error: grantErr } };
  let grants = [companyId];
  if (ctx.user.hierarchy === "DexterIndiaCompanyTeam" && Array.isArray(ctx.body.grantedCompanyIds)) {
    grants = ctx.body.grantedCompanyIds.map(oid).filter(Boolean);
    if (!grantsWithin(ctx.user, grants)) return { status: 403, body: { error: "you can only grant companies you hold" } };
    if (!grants.some((g) => String(g) === String(companyId))) grants.unshift(companyId);
  }
  const tk = await templateKey(companyId, ctx.body.roleTemplate);
  if (tk.error) return { status: 400, body: { error: tk.error } };
  const existing = await repo.users.findOne({ login });
  if (existing) return { status: 409, body: { error: "login exists" } };
  const pass = hashPassword(password);
  const doc = {
    login,
    name,
    mobile: String(ctx.body.mobile || "").replace(/[\s-]/g, ""),
    email: String(ctx.body.email || "").trim().toLowerCase(),
    active: false,
    hierarchy,
    functionalRole,
    companyId,
    projectIds,
    scopeRegion: String(ctx.body.scopeRegion || "").trim(),
    team: String(ctx.body.team || "").trim(),
    recordScope: RECORD_SCOPES.includes(ctx.body.recordScope) ? ctx.body.recordScope : "all",
    scopeAtmIds: idList(ctx.body.scopeAtmIds),
    scopeSiteIds: idList(ctx.body.scopeSiteIds),
    scopeTicketCategories: textList(ctx.body.scopeTicketCategories, 50),
    scopeDockets: idList(ctx.body.scopeDockets),
    roleTemplate: tk.key,
    franchiseId: ctx.body.franchiseId ? oid(ctx.body.franchiseId) : null,
    grantedCompanyIds: grants,
    actions,
    modules,
    passwordSalt: pass.salt,
    passwordHash: pass.hash,
    mfaRequired: true,
    createdAt: new Date(),
  };
  const result = await repo.users.insert(doc).catch((err) => {
    if (err && err.code === 11000) return null;
    throw err;
  });
  if (!result) return { status: 409, body: { error: "login exists" } };
  await writeAudit(ctx, "UserCreated", { companyId, module: "CRM-01", recordId: result.insertedId, after: { login, hierarchy, active: false } });
  return { status: 200, body: { id: String(result.insertedId), active: false, message: "User cannot log in until Admin activates" } };
}

async function patchUsersByIdActivate(ctx) {
  const id = oid(ctx.params.id);
  if (!id) return { status: 400, body: { error: "bad id" } };
  const row = await repo.users.findById(id);
  if (!row) return { status: 404, body: { error: "not found" } };
  if (!companyScope(ctx.user, row.companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  if (!(CREATABLE_LAYERS[ctx.user.hierarchy] || []).includes(row.hierarchy)) {
    return { status: 403, body: { error: "you cannot activate a " + row.hierarchy + " user" } };
  }
  if (String(row._id) === String(ctx.user._id)) return { status: 403, body: { error: "you cannot activate yourself" } };
  await repo.users.updateById(id, { $set: { active: true } });
  await writeAudit(ctx, "UserActivated", { companyId: row.companyId, module: "CRM-01", recordId: id, before: { active: row.active }, after: { active: true } });
  return { status: 200, body: { ok: true } };
}

async function patchUsersByIdUnlock(ctx) {
  const id = oid(ctx.params.id);
  const row = id ? await repo.users.findById(id) : null;
  if (!row) return { status: 404, body: { error: "not found" } };
  if (!companyScope(ctx.user, row.companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  if (!(CREATABLE_LAYERS[ctx.user.hierarchy] || []).includes(row.hierarchy)) return { status: 403, body: { error: "you cannot unlock a " + row.hierarchy + " user" } };
  if (!row.lockedUntil && !row.failedLogins) return { status: 400, body: { error: "account is not locked" } };
  await repo.users.updateById(id, { $set: { failedLogins: 0, lockedUntil: null } });
  await writeAudit(ctx, "LoginUnlocked", { companyId: row.companyId, module: "CRM-01", recordId: id, before: { lockedUntil: row.lockedUntil || null, failedLogins: row.failedLogins || 0 }, after: { lockedUntil: null, failedLogins: 0 }, work: row.login });
  return { status: 200, body: { ok: true } };
}

// Admin sets a temporary password; every session of that user ends so the old password stops working at once.
async function postUsersByIdResetPassword(ctx) {
  const id = oid(ctx.params.id);
  const row = id ? await repo.users.findById(id) : null;
  if (!row) return { status: 404, body: { error: "not found" } };
  if (!companyScope(ctx.user, row.companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  if (!(CREATABLE_LAYERS[ctx.user.hierarchy] || []).includes(row.hierarchy)) return { status: 403, body: { error: "you cannot reset a " + row.hierarchy + " user's password" } };
  if (String(row._id) === String(ctx.user._id)) return { status: 400, body: { error: "change your own password from My security" } };
  const password = String(ctx.body.password || "");
  const weak = passwordProblem(password);
  if (weak) return { status: 400, body: { error: weak } };
  const pass = hashPassword(password);
  await repo.users.updateById(id, { $set: { passwordSalt: pass.salt, passwordHash: pass.hash, failedLogins: 0, lockedUntil: null, passwordChangedAt: new Date() } });
  await repo.sessions.deleteMany({ userId: id });
  await endSessionLog({ userId: id }, "Revoked");
  await writeAudit(ctx, "PasswordReset", { companyId: row.companyId, module: "CRM-01", recordId: id, login: row.login, work: "temporary password set by " + (ctx.user.login || "admin") });
  return { status: 200, body: { ok: true } };
}

async function patchUsersById(ctx) {
  const id = oid(ctx.params.id);
  const row = id ? await repo.users.findById(id) : null;
  if (!row) return { status: 404, body: { error: "not found" } };
  if (!companyScope(ctx.user, row.companyId)) return { status: 403, body: { error: "company scope" } };
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const allowed = CREATABLE_LAYERS[ctx.user.hierarchy] || [];
  if (!allowed.includes(row.hierarchy)) return { status: 403, body: { error: "you cannot edit a " + row.hierarchy + " user" } };

  const b = ctx.body;
  const set = {};
  const events = [];
  if (b.hierarchy !== undefined && b.hierarchy !== row.hierarchy) {
    if (!allowed.includes(b.hierarchy)) return { status: 403, body: { error: "you cannot grant " + b.hierarchy } };
    set.hierarchy = b.hierarchy;
  }
  if (b.functionalRole !== undefined) {
    if (!FUNCTIONAL_ROLES.includes(b.functionalRole)) return { status: 400, body: { error: "unknown functional role" } };
    set.functionalRole = b.functionalRole;
  }
  if (b.actions !== undefined) {
    if (!Array.isArray(b.actions) || b.actions.some((a) => !ALL_ACTIONS.includes(a))) return { status: 400, body: { error: "unknown action" } };
    set.actions = b.actions;
  }
  if (b.modules !== undefined) set.modules = Array.isArray(b.modules) ? b.modules.map(String) : [];
  if (b.roleTemplate !== undefined && String(b.roleTemplate || "") !== (row.roleTemplate || "")) {
    const tk = await templateKey(row.companyId, b.roleTemplate);
    if (tk.error) return { status: 400, body: { error: tk.error } };
    set.roleTemplate = tk.key;
  }
  const self = String(row._id) === String(ctx.user._id);
  const same = (a, b2) => (a || []).map(String).sort().join(",") === (b2 || []).map(String).sort().join(",");
  const selfChange = set.hierarchy || (set.actions && !same(set.actions, row.actions)) || (set.modules && !same(set.modules, row.modules)) || (set.functionalRole !== undefined && set.functionalRole !== (row.functionalRole || ""));
  if (self && selfChange) {
    return { status: 403, body: { error: "you cannot change your own role, actions or modules" } };
  }
  const finalLayer = set.hierarchy || row.hierarchy;
  const actionsChanged = set.hierarchy || (set.actions && !same(set.actions, row.actions));
  const modulesChanged = set.modules && !same(set.modules, row.modules);
  const grantErr = checkGrantable(ctx.user, actionsChanged ? set.actions || row.actions || [] : undefined, modulesChanged ? set.modules : undefined, finalLayer);
  if (grantErr) return { status: 403, body: { error: grantErr } };
  const roleErr = checkRoleForLayer(finalLayer, set.functionalRole !== undefined ? set.functionalRole : row.functionalRole || "");
  if (roleErr) return { status: 400, body: { error: roleErr } };
  if (set.hierarchy || set.functionalRole !== undefined || set.actions || set.modules || set.roleTemplate !== undefined) events.push("RoleChanged");

  if (b.franchiseId !== undefined || set.hierarchy) {
    const fid = b.franchiseId !== undefined ? b.franchiseId : row.franchiseId;
    if (FRANCHISE_LAYERS.includes(finalLayer)) {
      const node = fid ? await repo.franchises.findOne({ _id: oid(fid), companyId: row.companyId }) : null;
      if (!node) return { status: 400, body: { error: "franchise-network user needs a franchise node in this company" } };
      if (node.layer && node.layer !== finalLayer) return { status: 400, body: { error: "a " + finalLayer + " user needs a " + finalLayer + " node (this node is " + node.layer + ")" } };
      set.franchiseId = node._id;
    } else {
      set.franchiseId = null;
    }
  }
  if (b.projectIds !== undefined) {
    set.projectIds = (b.projectIds || []).map(oid).filter(Boolean);
    const known = await repo.projects.count({ _id: { $in: set.projectIds }, companyId: row.companyId });
    if (known !== set.projectIds.length) return { status: 400, body: { error: "project not in this company" } };
    if (same(set.projectIds, row.projectIds)) delete set.projectIds;
    else {
      const projErr = projectsWithin(ctx.user, set.projectIds);
      if (projErr) return { status: 403, body: { error: projErr } };
    }
  }
  if (b.scopeRegion !== undefined) set.scopeRegion = String(b.scopeRegion || "").trim();
  if (b.team !== undefined) set.team = String(b.team || "").trim();
  if (b.recordScope !== undefined) {
    if (!RECORD_SCOPES.includes(b.recordScope)) return { status: 400, body: { error: "recordScope must be all, team or own" } };
    set.recordScope = b.recordScope;
  }
  if (b.scopeAtmIds !== undefined) set.scopeAtmIds = idList(b.scopeAtmIds);
  if (b.scopeSiteIds !== undefined) set.scopeSiteIds = idList(b.scopeSiteIds);
  if (b.scopeTicketCategories !== undefined) set.scopeTicketCategories = textList(b.scopeTicketCategories, 50);
  if (b.scopeDockets !== undefined) set.scopeDockets = idList(b.scopeDockets);
  if (self) {
    const txt = (v) => String(v || "");
    const selfScope =
      set.projectIds ||
      (set.scopeRegion !== undefined && set.scopeRegion !== txt(row.scopeRegion)) ||
      (set.team !== undefined && set.team !== txt(row.team)) ||
      (set.recordScope && set.recordScope !== (row.recordScope || "all")) ||
      (set.scopeAtmIds && !same(set.scopeAtmIds, row.scopeAtmIds)) ||
      (set.scopeSiteIds && !same(set.scopeSiteIds, row.scopeSiteIds)) ||
      (set.scopeTicketCategories && !same(set.scopeTicketCategories, row.scopeTicketCategories)) ||
      (set.scopeDockets && !same(set.scopeDockets, row.scopeDockets)) ||
      (set.franchiseId !== undefined && txt(set.franchiseId) !== txt(row.franchiseId));
    if (selfScope) return { status: 403, body: { error: "you cannot change your own scope" } };
  }
  if (set.franchiseId !== undefined || set.projectIds || set.scopeRegion !== undefined || set.team !== undefined || set.recordScope || set.scopeAtmIds || set.scopeSiteIds || set.scopeTicketCategories || set.scopeDockets) events.push("ScopeChanged");
  if (b.mfaRequired !== undefined && !!b.mfaRequired !== (row.mfaRequired !== false)) {
    if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "only Admin changes MFA for a user" } };
    if (self) return { status: 403, body: { error: "you cannot change your own MFA requirement" } };
    set.mfaRequired = !!b.mfaRequired;
    events.push("MfaPolicyChanged");
  }
  if (b.resetMfa && (row.totpEnabled || (row.recoveryCodes || []).length)) {
    if (!["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy)) return { status: 403, body: { error: "only Admin resets MFA" } };
    set.totpEnabled = false;
    set.totpSecret = null;
    set.recoveryCodes = [];
    events.push("MfaRemoved");
  }

  if (b.grantedCompanyIds !== undefined && ctx.user.hierarchy !== "DexterIndiaCompanyTeam") {
    return { status: 403, body: { error: "only Dexter India / Company Team grants companies" } };
  }
  if (b.grantedCompanyIds !== undefined && finalLayer === "DexterIndiaCompanyTeam") {
    if (self) return { status: 403, body: { error: "you cannot change your own company grants" } };
    const asked = (b.grantedCompanyIds || []).map(oid).filter(Boolean);
    if (!grantsWithin(ctx.user, asked)) return { status: 403, body: { error: "you can only grant companies you hold" } };
    const mine = ctx.user.grantedCompanyIds && ctx.user.grantedCompanyIds.length ? ctx.user.grantedCompanyIds : [ctx.user.homeCompanyId || ctx.user.companyId];
    const hidden = (row.grantedCompanyIds || []).filter((id) => !mine.some((m) => String(m) === String(id)));
    const next = [...new Set([...hidden, ...asked, row.companyId].map(String))].map(oid);
    const key = (list) => list.map(String).sort().join(",");
    if (key(next) !== key(row.grantedCompanyIds || [])) {
      set.grantedCompanyIds = next;
      events.push("GrantChanged");
    }
  }
  const profile = {};
  if (b.name !== undefined) {
    const name = String(b.name || "").trim();
    if (!name) return { status: 400, body: { error: "name cannot be empty" } };
    if (name !== row.name) profile.name = name;
  }
  if (b.mobile !== undefined) {
    const mobile = String(b.mobile || "").replace(/[\s-]/g, "");
    if (mobile && !/^\+?\d{10,13}$/.test(mobile)) return { status: 400, body: { error: "mobile must be 10–13 digits" } };
    if (mobile !== (row.mobile || "")) profile.mobile = mobile;
  }
  if (b.email !== undefined) {
    const email = String(b.email || "").trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: "email is not valid" } };
    if (email !== (row.email || "")) profile.email = email;
  }
  if (Object.keys(profile).length) {
    Object.assign(set, profile);
    events.push("ProfileChanged");
  }
  if (b.active === false && row.active) {
    if (String(row._id) === String(ctx.user._id)) return { status: 400, body: { error: "cannot deactivate yourself" } };
    set.active = false;
    events.push("UserDeactivated");
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };

  await repo.users.updateById(id, { $set: set });
  if (set.active === false || set.hierarchy || set.grantedCompanyIds) {
    await repo.sessions.deleteMany({ userId: id });
    await endSessionLog({ userId: id }, "Revoked");
  }
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  const after = { ...set };
  for (const k of ["totpSecret", "recoveryCodes"]) {
    if (k in before) before[k] = before[k] && (Array.isArray(before[k]) ? before[k].length + " codes" : "set");
    if (k in after) after[k] = "cleared";
  }
  for (const ev of events) {
    await writeAudit(ctx, ev, { companyId: row.companyId, module: "CRM-01", recordId: id, before, after });
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { idList, textList, roleTemplates, getRoleTemplates, putRoleTemplates, effectiveActions, checkGrantable, checkRoleForLayer, grantsWithin, getUsers, postUsers, patchUsersByIdActivate, patchUsersByIdUnlock, postUsersByIdResetPassword, patchUsersById };
