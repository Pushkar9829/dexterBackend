const COLLECTIONS = ["atms","companies","complaints","counters","documents","employees","franchises","lookups","site_projects","task_templates","tasks","users"];

const STATUSES = [
  "Pending Approval",
  "Created",
  "Assigned",
  "Rejected",
  "Accepted",
  "Pending",
  "In Progress",
  "On Hold",
  "Submitted for Review",
  "Under Review",
  "Rework Required",
  "Approved",
  "Completed",
  "Closed",
  "Cancelled",
];

const DONE = ["Completed", "Closed", "Cancelled"];

// Assignee may turn a task down before starting it.
const REJECTABLE = ["Assigned", "Accepted"];

const PRIORITIES = ["Low", "Medium", "High", "Critical"];

const CATEGORIES = ["Field", "Office"];

const TYPES = ["General", "Follow-up", "Site visit", "Document", "Finance", "Operations", "Service", "Project"];

// evidence: file labels required before completion; gps: field check-in/out required.
const DEFAULT_TASK_TYPES = [
  { name: "General", subTypes: [] },
  { name: "Follow-up", subTypes: ["Call", "Mail", "Meeting"] },
  { name: "Site visit", subTypes: ["Survey", "Installation", "Maintenance", "Audit"], evidence: ["Site photo"], gps: true },
  { name: "Document", subTypes: ["KYC", "Agreement", "Report"] },
  { name: "Finance", subTypes: ["Payout", "Invoice", "Reconciliation"] },
  { name: "Operations", subTypes: ["Cash", "EOD", "Inventory"] },
  { name: "Service", subTypes: ["Complaint", "Inspection"] },
  { name: "Project", subTypes: [] },
];

const SOURCES = ["Manual", "Ticket", "Project", "Recurring", "Email", "Inspection", "Agreement", "KYC"];

const FREQUENCIES = ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly", "Every N days"];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTHLY_MODES = ["date", "weekday"];

// Hours overdue at which each escalation level fires; null = level off.
const DEFAULT_ESCALATION = {
  Critical: [0, 4, 12],
  High: [0, 12, 36],
  Medium: [null, null, null],
  Low: [null, null, null],
};

const ESCALATION_LEVELS = ["Team Lead", "Manager", "Senior Management"];

const DEFAULT_REMINDER_RULES = { daysBefore: [1], onDue: true };

const TEMPLATE_STATUSES = ["Active", "Paused", "Inactive"];

const MISSED_POLICIES = ["Independent Generation", "Block Next", "Carry Forward"];

const DEFAULT_DUE_HOURS = { Critical: 4, High: 24, Medium: 72, Low: 168 };

const DEFAULT_ESCALATE_AFTER = { Critical: 4, High: 12 };

const REVIEW_STEPS = ["Under Review", "Approved", "Rework Required"];

const NEXT = {
  Rejected: [],
  Assigned: ["Accepted", "On Hold"],
  Accepted: ["In Progress", "Pending", "On Hold"],
  Pending: ["In Progress", "On Hold"],
  "In Progress": ["Pending", "On Hold", "Submitted for Review", "Completed"],
  "On Hold": ["In Progress"],
  "Submitted for Review": ["Under Review"],
  "Under Review": ["Approved", "Rework Required"],
  "Rework Required": ["In Progress"],
  Approved: ["Completed", "Closed"],
  Completed: ["Closed"],
};

const utc = (s) => new Date(s + "T00:00:00Z");
const isoDow = (d) => ((d.getUTCDay() + 6) % 7) + 1;
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

function recurrenceMonths(freq, interval) {
  if (freq === "Quarterly") return 3 * interval;
  if (freq === "Yearly") return 12 * interval;
  return interval;
}

// True when date s (YYYY-MM-DD) is an occurrence of the template's rule.
function occursOn(s, tpl) {
  if (s < tpl.startDate || (tpl.endDate && s > tpl.endDate)) return false;
  const interval = Math.max(1, Number(tpl.interval) || 1);
  const d = utc(s);
  const start = utc(tpl.startDate);
  const freq = tpl.frequency;
  if (freq === "Daily" || freq === "Every N days") return daysBetween(tpl.startDate, s) % interval === 0;
  if (freq === "Weekly") {
    const days = (tpl.weekdays && tpl.weekdays.length ? tpl.weekdays : [isoDow(start)]).map(Number);
    if (!days.includes(isoDow(d))) return false;
    const weekStart = (x) => new Date(x.getTime() - (isoDow(x) - 1) * 86400000);
    return Math.round((weekStart(d) - weekStart(start)) / (7 * 86400000)) % interval === 0;
  }
  const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
  if (months < 0 || months % recurrenceMonths(freq, interval) !== 0) return false;
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (tpl.monthlyMode === "weekday") {
    const dow = Number(tpl.weekday) || isoDow(start);
    if (isoDow(d) !== dow) return false;
    const nth = Number(tpl.nth) || Math.ceil(start.getUTCDate() / 7);
    return nth === -1 ? d.getUTCDate() + 7 > last : Math.ceil(d.getUTCDate() / 7) === nth;
  }
  return d.getUTCDate() === Math.min(start.getUTCDate(), last);
}

function describeRecurrence(tpl) {
  const n = Math.max(1, Number(tpl.interval) || 1);
  const every = (unit) => (n > 1 ? "every " + n + " " + unit + "s" : "every " + unit);
  let s;
  if (tpl.frequency === "Every N days") s = "every " + n + " days";
  else if (tpl.frequency === "Daily") s = every("day");
  else if (tpl.frequency === "Weekly") s = every("week") + " on " + (tpl.weekdays && tpl.weekdays.length ? tpl.weekdays : [isoDow(utc(tpl.startDate))]).map((x) => WEEKDAYS[x - 1]).join(", ");
  else {
    const unit = tpl.frequency === "Quarterly" ? "quarter" : tpl.frequency === "Yearly" ? "year" : "month";
    const nthLabel = { 1: "first", 2: "second", 3: "third", 4: "fourth", "-1": "last" };
    const month = tpl.frequency === "Yearly" ? " of " + utc(tpl.startDate).toLocaleString("en-IN", { month: "short", timeZone: "UTC" }) : "";
    s = every(unit) + (tpl.monthlyMode === "weekday" ? " on the " + nthLabel[Number(tpl.nth) || 1] + " " + WEEKDAYS[(Number(tpl.weekday) || 1) - 1] + month : " on day " + Number(tpl.startDate.slice(8, 10)) + month);
  }
  return s + " from " + tpl.startDate + (tpl.endDate ? " until " + tpl.endDate : " (permanent)");
}

module.exports = { COLLECTIONS, STATUSES, DONE, REJECTABLE, PRIORITIES, CATEGORIES, TYPES, DEFAULT_TASK_TYPES, SOURCES, FREQUENCIES, WEEKDAYS, MONTHLY_MODES, TEMPLATE_STATUSES, MISSED_POLICIES, DEFAULT_DUE_HOURS, DEFAULT_ESCALATE_AFTER, DEFAULT_ESCALATION, ESCALATION_LEVELS, DEFAULT_REMINDER_RULES, REVIEW_STEPS, NEXT, occursOn, describeRecurrence };
