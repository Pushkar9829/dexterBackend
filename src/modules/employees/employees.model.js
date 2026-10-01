const COLLECTIONS = ["employees","sessions","users"];

const EMPLOYMENT_STATUSES = ["Active", "Inactive", "On Leave", "Unavailable", "Suspended", "Resigned", "Exited"];

const skillList = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v || "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean))].slice(0, 30);

module.exports = { COLLECTIONS, EMPLOYMENT_STATUSES, skillList };
