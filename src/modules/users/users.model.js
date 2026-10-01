const { FRANCHISE_LAYERS } = require("../../utils/scope");

const COLLECTIONS = ["employees","franchises","lookups","projects","session_log","sessions","teams","users"];

const ALL_ACTIONS = ["View", "Create", "Edit", "Delete", "Approve", "Reject", "Assign", "Export", "Close"];

const FUNCTIONAL_ROLES = ["", "Verifier", "Executive", "SalesOfficer", "Finance", "ServiceProjectOps", "Inspector", "Auditor", "Viewer", "HR"];

const MODULE_CODES = ["CRM-01", "CRM-02", "CRM-03", "CRM-04", "CRM-05", "CRM-06", "CRM-07", "CRM-08"];

// Built-in role templates. Custom ones live in lookups.roleTemplates with the same shape.
const ROLE_PRESETS = [
  { key: "auditor", name: "Read-only Auditor", description: "Sees every module and the audit log; can export, cannot change anything.", hierarchy: "SubAdmin", functionalRole: "Auditor", actions: ["View", "Export"], modules: MODULE_CODES, recordScope: "all" },
  { key: "hr-team-manager", name: "HR / Team Manager", description: "Employees, users, teams and task assignment.", hierarchy: "SubAdmin", functionalRole: "HR", actions: ["View", "Create", "Edit", "Assign", "Export"], modules: ["CRM-01", "CRM-06", "CRM-07"], recordScope: "all" },
  { key: "dept-head-viewer", name: "Department Head / Viewer", description: "Read-only view of their team's records, dashboards and tasks.", hierarchy: "SubAdmin", functionalRole: "Viewer", actions: ["View", "Export"], modules: ["CRM-03", "CRM-04", "CRM-05", "CRM-06", "CRM-07"], recordScope: "team" },
  { key: "kyc-team", name: "KYC team", description: "Verifies onboarding documents and KYC; approves or rejects.", hierarchy: "SubAdmin", functionalRole: "Verifier", actions: ["View", "Create", "Edit", "Approve", "Reject"], modules: ["CRM-02", "CRM-06"], recordScope: "all" },
];

const CREATABLE_LAYERS = {
  DexterIndiaCompanyTeam: ["DexterIndiaCompanyTeam", "Director", "Admin", "SubAdmin", ...FRANCHISE_LAYERS],
  Admin: ["SubAdmin", ...FRANCHISE_LAYERS],
  SubAdmin: FRANCHISE_LAYERS,
};

const RECORD_SCOPES = ["all", "team", "own"];

const OFFICE_ONLY_ROLES = ["Verifier", "Executive", "Finance", "SalesOfficer", "Inspector", "ServiceProjectOps", "Auditor", "Viewer", "HR"];

const SECRET_FIELDS = ["passwordHash", "passwordSalt", "totpSecret", "totpPending", "totpLastStep", "recoveryCodes"];

// The user row as an admin screen may see it: secrets removed, recovery codes reduced to a count.
function toPublic(u) {
  if (!u) return null;
  const out = { ...u };
  SECRET_FIELDS.forEach((k) => delete out[k]);
  out.recoveryLeft = (u.recoveryCodes || []).filter((c) => !c.usedAt && new Date(c.expiresAt) > new Date()).length;
  return out;
}

module.exports = { COLLECTIONS, ALL_ACTIONS, FUNCTIONAL_ROLES, MODULE_CODES, ROLE_PRESETS, CREATABLE_LAYERS, RECORD_SCOPES, OFFICE_ONLY_ROLES, SECRET_FIELDS, toPublic };
