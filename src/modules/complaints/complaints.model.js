const COLLECTIONS = ["atms","companies","complaints","counters","documents","franchises","inspections","lookups","site_projects","tasks","users","visits"];

const PROBLEM_TYPES = ["Server", "Print", "Dispenser", "Cash jam", "Card reader", "Network / VSAT", "Power / UPS", "Display", "Cash shortage", "Other"];

// Default complaint taxonomy; a company can replace it (lookups.complaintCategories). slaHours per category overrides the
// priority SLA for that category only.
const DEFAULT_CATEGORIES = [
  { name: "ATM technical", problemTypes: ["Server", "Print", "Dispenser", "Cash jam", "Card reader", "Display"], slaHours: {} },
  { name: "Network", problemTypes: ["Network / VSAT"], slaHours: {} },
  { name: "Electrical", problemTypes: ["Power / UPS", "Wiring / earthing"], slaHours: {} },
  { name: "Cash", problemTypes: ["Cash shortage"], slaHours: {} },
  { name: "Site", problemTypes: ["Site access", "Housekeeping", "Security / CCTV", "Civil work", "AC"], slaHours: {} },
  { name: "Branding", problemTypes: ["Branding / signage"], slaHours: {} },
  { name: "Commercial", problemTypes: ["Rent / commercial", "Payout query"], slaHours: {} },
  { name: "Other", problemTypes: ["Other"], slaHours: {} },
];

const PRIORITIES = ["Low", "Medium", "High", "Critical"];

// Dexter's names for the stored priority keys (DF: Critical 4 h / Normal 24 h / Routine 48 h). Keys stay unchanged in data.
const PRIORITY_LABELS = { Low: "Routine", Medium: "Normal", High: "High", Critical: "Critical" };
const priorityLabel = (p) => PRIORITY_LABELS[p] || p || "";
const priorityKey = (v) => {
  const s = String(v || "").trim();
  return PRIORITIES.find((k) => k.toLowerCase() === s.toLowerCase() || PRIORITY_LABELS[k].toLowerCase() === s.toLowerCase()) || s;
};

const DEFAULT_SLA_HOURS = { Critical: 4, High: 12, Medium: 24, Low: 48 };

const DEFAULT_AUTO_ESCALATE_HOURS = { SSM: 0, RM: 12, Management: 24 };

const STATUSES = [
  "Open",
  "Assigned",
  "In Progress",
  "Pending",
  "Field Visit Required",
  "Awaiting Spare",
  "Awaiting External Action",
  "Resolved",
  "Closed",
  "Reopened",
  "Escalated",
];

const DONE = ["Resolved", "Closed"];

const ESCALATION = ["None", "SSM", "RM", "Management"];

const CHANNELS = ["CRM", "App", "Mail"];

const VISIT_OUTCOMES = ["Resolved", "Awaiting Spare", "Awaiting External Action", "Follow-up visit"];

const SITE_STATUSES = ["Working", "Partially working", "Down"];

const INSPECTION_TYPES = ["Routine", "Surprise", "Audit", "Pre Cash Live", "Re-inspection"];

// Answer types: passfail (Pass/Fail/NA), yesno (Yes/No/NA), rating (1–5/NA). A "failed" item is Fail, No, or rating ≤ 2.
const ANSWERS = { passfail: ["Pass", "Fail", "NA"], yesno: ["Yes", "No", "NA"], rating: ["1", "2", "3", "4", "5", "NA"] };

const DEFAULT_CHECKLIST = [
  ...["Branding / signage", "Cleanliness", "Lighting", "Shutter / lock", "RBI notice / helpline board", "Fire extinguisher"].map((item) => ({ group: "Site", item, answer: "passfail", photo: item === "Branding / signage" })),
  ...["CCTV working", "AC working", "UPS / battery", "VSAT / network", "Cash withdrawal working", "Receipt printer"].map((item) => ({ group: "Equipment", item, answer: "passfail", photo: false })),
  { group: "Loading register", item: "Loading register maintained", answer: "yesno", photo: true },
  { group: "Loading register", item: "Last loading entry matches EOD", answer: "yesno", photo: false },
  { group: "Overall", item: "Overall site condition", answer: "rating", photo: false },
];

function itemFailed(c) {
  return c.result === "Fail" || c.result === "No" || ((c.answer || "passfail") === "rating" && ["1", "2"].includes(c.result));
}

const FIELD_ROLES = ["SalesOfficer", "Inspector"];

const COMPLAINT_OWNERS = ["ownerUserId", "createdBy", "visitOfficerIds"];

const FIELD_OWNERS = ["officerId", "createdBy"];

module.exports = { COLLECTIONS, PROBLEM_TYPES, DEFAULT_CATEGORIES, PRIORITIES, PRIORITY_LABELS, priorityLabel, priorityKey, DEFAULT_SLA_HOURS, DEFAULT_AUTO_ESCALATE_HOURS, STATUSES, DONE, ESCALATION, CHANNELS, VISIT_OUTCOMES, SITE_STATUSES, INSPECTION_TYPES, ANSWERS, DEFAULT_CHECKLIST, itemFailed, FIELD_ROLES, COMPLAINT_OWNERS, FIELD_OWNERS };
