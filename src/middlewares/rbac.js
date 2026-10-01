const ACTIONS = ["View", "Create", "Edit", "Delete", "Approve", "Reject", "Assign", "Export", "Close"];

const ROLE_ACTIONS = {
  DexterIndiaCompanyTeam: ACTIONS,
  Director: ["View", "Approve"],
  Admin: ACTIONS,
  SubAdmin: ["View", "Create", "Edit", "Approve", "Reject", "Assign", "Close"],
  SuperMasterFranchise: ["View", "Create", "Edit"],
  MasterFranchise: ["View", "Create", "Edit"],
  Franchise: ["View", "Create", "Edit"],
};

// Auditor / Viewer stay read-only whatever actions an admin ticks for them.
const READ_ONLY_ROLES = ["Auditor", "Viewer"];
const READ_ONLY_ACTIONS = ["View", "Export"];

function isReadOnly(user) {
  return !!user && READ_ONLY_ROLES.includes(user.functionalRole) && !["Admin", "DexterIndiaCompanyTeam"].includes(user.hierarchy);
}

function can(user, action, moduleName) {
  if (!user || !user.active) return false;
  const allowed = user.actions && user.actions.length ? user.actions : ROLE_ACTIONS[user.hierarchy] || [];
  if (!allowed.includes(action)) return false;
  if (isReadOnly(user) && !READ_ONLY_ACTIONS.includes(action)) return false;
  if (user.modules && user.modules.length && moduleName && !user.modules.includes(moduleName)) return false;
  return true;
}

function companyScope(user, companyId) {
  if (!user) return false;
  if (user.hierarchy === "DexterIndiaCompanyTeam") {
    const grants = user.grantedCompanyIds && user.grantedCompanyIds.length ? user.grantedCompanyIds : [user.homeCompanyId || user.companyId];
    return grants.some((id) => String(id) === String(companyId));
  }
  return String(user.companyId) === String(companyId);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "login required" });
  next();
}

// Writes a read-only user may still make: their own login, MFA, notices and client telemetry.
const READ_ONLY_WRITES = [/^\/api\/auth\//, /^\/api\/notices\/([^/]+\/read|read-all)$/, /^\/api\/audit\/client-event$/, /^\/api\/site-projects\/[^/]+\/pptx$/, /^\/api\/report-lists\/subscriptions(\/[^/]+)?$/];

function readOnlyGuard(req, res, next) {
  if (!isReadOnly(req.user) || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (READ_ONLY_WRITES.some((rx) => rx.test(req.path))) return next();
  return res.status(403).json({ error: "read-only role: " + req.user.functionalRole + " cannot change records" });
}

function requireAction(action, moduleName) {
  const guard = (req, res, next) => {
    if (!can(req.user, action, moduleName)) {
      return res.status(403).json({ error: "not allowed" });
    }
    next();
  };
  guard.permission = { action, module: moduleName };
  return guard;
}

function isFieldStaff(user) {
  return !!user && ["SalesOfficer", "Inspector"].includes(user.functionalRole) && !["Admin", "DexterIndiaCompanyTeam"].includes(user.hierarchy);
}

const DESK_ROLES = ["Verifier", "Executive", "Finance", "ServiceProjectOps", "Viewer"];

// Verifier / Executive / Finance / Ops / Viewer work their own desk only: no users, lookups, master data or approvals beyond their role.
function isDeskStaff(user) {
  return !!user && DESK_ROLES.includes(user.functionalRole) && !["Admin", "DexterIndiaCompanyTeam"].includes(user.hierarchy);
}

function isOfficeAdmin(user) {
  return ["DexterIndiaCompanyTeam", "Admin", "SubAdmin"].includes(user && user.hierarchy) && !isFieldStaff(user) && !isDeskStaff(user);
}

function isFranchiseNetwork(user) {
  return ["SuperMasterFranchise", "MasterFranchise", "Franchise"].includes(user && user.hierarchy);
}

function isOfficeStaff(user) {
  return !!user && !isFranchiseNetwork(user) && !isFieldStaff(user);
}

function officeRole(user, roles) {
  return !!user && !isFranchiseNetwork(user) && roles.includes(user.functionalRole);
}

function canCreateAtm(user) {
  if (!user) return false;
  if (isOfficeAdmin(user)) return true;
  return officeRole(user, ["ServiceProjectOps"]);
}

function canSetLinkShared(user) {
  if (!user) return false;
  if (user.hierarchy === "Admin" || user.hierarchy === "DexterIndiaCompanyTeam") return true;
  return officeRole(user, ["SalesOfficer"]);
}

function canApproveApplication(user) {
  if (!user) return false;
  if (isOfficeAdmin(user) || user.hierarchy === "Director") return true;
  return officeRole(user, ["Verifier"]);
}

module.exports = { ACTIONS, ROLE_ACTIONS, READ_ONLY_ROLES, isReadOnly, readOnlyGuard, can, companyScope, requireAuth, requireAction, isFieldStaff, isDeskStaff, isOfficeAdmin, isOfficeStaff, isFranchiseNetwork, officeRole, canCreateAtm, canSetLinkShared, canApproveApplication };
