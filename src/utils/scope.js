const { oid } = require("./ids");
const repo = require("./shared.repository");

async function franchiseIdsForUser(user) {
  if (!user.franchiseId) return [];
  const fid = user.franchiseId;
  if (user.hierarchy === "Franchise") return [fid];
  if (user.hierarchy === "MasterFranchise") {
    const kids = await repo.franchises.list({ companyId: user.companyId, masterId: fid }, { projection: { _id: 1 } });
    return [fid, ...kids.map((k) => k._id)];
  }
  if (user.hierarchy === "SuperMasterFranchise") {
    const kids = await repo.franchises.list({ companyId: user.companyId, $or: [{ superMasterId: fid }, { masterId: fid }] }, { projection: { _id: 1 } });
    return [fid, ...kids.map((k) => k._id)];
  }
  return [];
}

const PROJECT_FREE_LAYERS = ["DexterIndiaCompanyTeam", "Admin", "Director"];

function byProject(user) {
  return !!user && !PROJECT_FREE_LAYERS.includes(user.hierarchy) && (user.projectIds || []).length > 0;
}

function byRegion(user) {
  return !!user && !PROJECT_FREE_LAYERS.includes(user.hierarchy) && !!user.scopeRegion;
}

function byAtmList(user) {
  return !!user && !PROJECT_FREE_LAYERS.includes(user.hierarchy) && ((user.scopeAtmIds || []).length > 0 || (user.scopeSiteIds || []).length > 0);
}

function projectScoped(user) {
  return byProject(user) || byRegion(user) || byAtmList(user);
}

async function projectAtmIds(user) {
  if (!projectScoped(user)) return null;
  const q = { companyId: oid(user.companyId), $and: [] };
  if (byProject(user)) q.$and.push({ $or: [{ projectId: { $in: user.projectIds.map(oid) } }, { projectId: null }] });
  if (byRegion(user)) q.$and.push({ $or: [{ region: user.scopeRegion }, { region: null }, { region: "" }] });
  if ((user.scopeAtmIds || []).length) q.$and.push({ atmId: { $in: user.scopeAtmIds } });
  if ((user.scopeSiteIds || []).length) q.$and.push({ siteId: { $in: user.scopeSiteIds } });
  const atms = await repo.atms.list(q, { projection: { atmId: 1 } });
  return atms.map((a) => a.atmId);
}

function applyRecordProject(user, filter) {
  if (!byProject(user)) return filter;
  (filter.$and = filter.$and || []).push({ projectId: { $in: user.projectIds.map(oid) } });
  return filter;
}

function recordInProject(user, row) {
  if (!byProject(user) || !row) return true;
  return !!row.projectId && user.projectIds.some((p) => String(p) === String(row.projectId));
}

async function defaultProjectId(user, companyId, asked) {
  if (asked) {
    const p = await repo.projects.findOne({ _id: oid(asked), companyId: oid(companyId) });
    if (!p) return { error: "project not in this company" };
    if (byProject(user) && !user.projectIds.some((x) => String(x) === String(p._id))) return { error: "project outside your scope" };
    return { projectId: p._id };
  }
  if (byProject(user)) return { projectId: oid(user.projectIds[0]) };
  const main = await repo.projects.find({ companyId: oid(companyId) }).project({ _id: 1 }).sort({ createdAt: 1, _id: 1 }).limit(1).next();
  return { projectId: main ? main._id : null };
}

async function teamMemberIds(user) {
  if (!user.team) return [user._id];
  const list = await repo.users.list({ companyId: user.companyId, $or: [{ team: user.team }, { "taskProfile.team": user.team }] }, { projection: { _id: 1 } });
  return list.map((u) => u._id);
}

function recordScope(user) {
  if (!user || PROJECT_FREE_LAYERS.includes(user.hierarchy) || FRANCHISE_LAYERS.includes(user.hierarchy)) return "all";
  return ["team", "own"].includes(user.recordScope) ? user.recordScope : "all";
}

async function applyRecordScope(user, filter, ownerFields, teamField) {
  const level = recordScope(user);
  if (level === "all") return filter;
  const ids = level === "own" ? [user._id] : await teamMemberIds(user);
  const or = ownerFields.map((f) => ({ [f]: { $in: ids } }));
  if (level === "team" && teamField && user.team) or.push({ [teamField]: user.team });
  (filter.$and = filter.$and || []).push({ $or: or });
  return filter;
}

async function inRecordScope(user, row, ownerFields, teamField) {
  const level = recordScope(user);
  if (level === "all" || !row) return true;
  const ids = (level === "own" ? [user._id] : await teamMemberIds(user)).map(String);
  if (ownerFields.some((f) => row[f] && ids.includes(String(row[f])))) return true;
  return level === "team" && !!teamField && !!user.team && row[teamField] === user.team;
}

// Ticket-set scope: office users limited to chosen complaint categories and/or dockets.
function byTicketSet(user) {
  return !!user && !PROJECT_FREE_LAYERS.includes(user.hierarchy) && !FRANCHISE_LAYERS.includes(user.hierarchy) && ((user.scopeTicketCategories || []).length > 0 || (user.scopeDockets || []).length > 0);
}

function applyTicketSet(user, filter) {
  if (!byTicketSet(user)) return filter;
  const or = [];
  if ((user.scopeTicketCategories || []).length) or.push({ category: { $in: user.scopeTicketCategories } });
  if ((user.scopeDockets || []).length) or.push({ docketNumber: { $in: user.scopeDockets } });
  (filter.$and = filter.$and || []).push({ $or: or });
  return filter;
}

function inTicketSet(user, row) {
  if (!byTicketSet(user) || !row) return true;
  return (user.scopeTicketCategories || []).includes(row.category) || (user.scopeDockets || []).includes(row.docketNumber);
}

async function applyProjectFilter(user, filter, key) {
  const ids = await projectAtmIds(user);
  if (!ids) return filter;
  (filter.$and = filter.$and || []).push({ [key || "atmId"]: { $in: [...ids, null, ""] } });
  return filter;
}

function atmInProject(user, atm) {
  if (!projectScoped(user) || !atm) return true;
  if (byProject(user) && atm.projectId && !user.projectIds.some((p) => String(p) === String(atm.projectId))) return false;
  if (byRegion(user) && atm.region && atm.region !== user.scopeRegion) return false;
  if ((user.scopeAtmIds || []).length && !user.scopeAtmIds.includes(atm.atmId)) return false;
  if ((user.scopeSiteIds || []).length && !user.scopeSiteIds.includes(atm.siteId)) return false;
  return true;
}

async function atmIdInProject(user, companyId, atmId) {
  if (!projectScoped(user) || !atmId) return true;
  return atmInProject(user, await repo.atms.findOne({ companyId: oid(companyId), atmId }));
}

async function applyFranchiseFilter(user, filter, field) {
  const key = field || "franchiseId";
  if (key === "franchiseId") await applyProjectFilter(user, filter, "atmId");
  if (!["Franchise", "MasterFranchise", "SuperMasterFranchise"].includes(user.hierarchy)) {
    return filter;
  }
  const ids = await franchiseIdsForUser(user);
  if (!ids.length) {
    if (key === "createdBy") filter.createdBy = user._id;
    else filter[key] = { $in: [] };
    return filter;
  }
  filter[key] = { $in: ids };
  return filter;
}

const FRANCHISE_LAYERS = ["Franchise", "MasterFranchise", "SuperMasterFranchise"];

async function inFranchiseScope(user, franchiseId) {
  if (!FRANCHISE_LAYERS.includes(user.hierarchy)) return true;
  if (!franchiseId) return false;
  const ids = await franchiseIdsForUser(user);
  return ids.some((id) => String(id) === String(franchiseId));
}

module.exports = { byTicketSet, applyTicketSet, inTicketSet, franchiseIdsForUser, PROJECT_FREE_LAYERS, byProject, byRegion, byAtmList, projectScoped, projectAtmIds, applyRecordProject, recordInProject, defaultProjectId, teamMemberIds, recordScope, applyRecordScope, inRecordScope, applyProjectFilter, atmInProject, atmIdInProject, applyFranchiseFilter, FRANCHISE_LAYERS, inFranchiseScope };
