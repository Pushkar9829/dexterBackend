const COLLECTIONS = ["applications","documents","franchises","users"];

const PARENT_COLLECTIONS = {
  application: "applications",
  loi: "lois",
  agreement: "agreements",
  project: "site_projects",
  overage: "overage_deposits",
  complaint: "complaints",
  visit: "visits",
  inspection: "inspections",
  payment: "payments",
  bankStatement: "bank_statements",
  tds: "tds_letters",
  gstBill: "gst_bills",
  payoutAccount: "payout_accounts",
  mail: "mails",
  trackerRow: "tracker_rows",
  apna: "apna_mappings",
  task: "tasks",
};

const MAIL_PARENTS = ["mail", "trackerRow"];

const OWN_PAGE_PARENTS = { mail: "Mail", trackerRow: "Mail", task: "Tasks" };

const SERVICE_PARENTS = ["complaint", "visit", "inspection"];

const LOCKED_PARENT_STATUSES = {
  loi: ["Approved", "Rejected"],
  agreement: ["Approved", "Rejected"],
  visit: ["Submitted", "Cancelled"],
  inspection: ["Submitted", "Verified"],
  complaint: ["Closed"],
  payment: ["Submitted", "Approved", "Settled", "Rejected"],
  gstBill: ["Submitted", "Under Processing", "Completed"],
  payoutAccount: ["Verified"],
};

const FIELD_OPEN_PARENTS = ["application", "loi", "agreement", "project"];

// Module whose View right an office user needs to see files attached to each parent (tasks use task visibility).
const PARENT_MODULE = {
  application: "CRM-02",
  loi: "CRM-02",
  agreement: "CRM-02",
  apna: "CRM-02",
  project: "CRM-03",
  overage: "CRM-04",
  payment: "CRM-04",
  bankStatement: "CRM-04",
  tds: "CRM-04",
  gstBill: "CRM-04",
  payoutAccount: "CRM-04",
  complaint: "CRM-05",
  visit: "CRM-05",
  inspection: "CRM-05",
  mail: "CRM-05",
  trackerRow: "CRM-05",
};

const PROJECT_PARENTS = ["application", "loi", "agreement", "project"];

module.exports = { COLLECTIONS, PARENT_COLLECTIONS, MAIL_PARENTS, OWN_PAGE_PARENTS, SERVICE_PARENTS, LOCKED_PARENT_STATUSES, FIELD_OPEN_PARENTS, PARENT_MODULE, PROJECT_PARENTS };
