const COLLECTIONS = ["atms","companies","sessions","users"];

const MOVABLE = {
  user: { name: "users", clear: ["franchiseId", "projectIds", "grantedCompanyIds"], label: (r) => r.login },
  franchise: { name: "franchises", clear: ["masterId", "superMasterId"], label: (r) => r.name },
  atm: { name: "atms", clear: ["franchiseId", "projectId"], label: (r) => r.atmId },
  application: { name: "applications", clear: ["franchiseId", "projectId"], label: (r) => r.siteLocationName || String(r._id) },
};

module.exports = { COLLECTIONS, MOVABLE };
