const COLLECTIONS = ["agreements","apna_mappings","applications","atms","documents","franchises","gst_bills","lois","lookups","ops_txn","payout_accounts","security_deposits","site_projects","tasks"];

const STAGES = [
  "Project Assigned",
  "TIS",
  "Electrical",
  "Assets Delivery",
  "UPS",
  "VSAT",
  "ATM Installation",
  "Branding",
  "Testing",
  "Tech Live",
  "Cash Live",
  "Project Completed",
];

const STAGE_STATUSES = [
  "Pending",
  "Assigned",
  "In Progress",
  "Delivered",
  "Installation pending",
  "Installation done",
  "Done",
  "Complete",
  "date captured",
  "Mail sent for letters",
];

const NO_EVIDENCE_STAGES = ["Project Assigned", "Project Completed"];

const BRANDING_ITEMS = ["signage", "lollypop", "operatorBranding", "monkeyCage", "grouting"];

const BOARD_FIELDS = ["sd", "agreementStatus", "apnaRegistration", "wlaAccountStatus", "payoutAccountStatus", "gstStatus", "projectedCompletion"];

const READINESS_ITEMS = ["battery", "stabilizer", "isolationTransformer", "camera", "ups", "vsat", "atm", "grouting", "branding"];

const HEADER_FIELDS = ["projectName", "applyDate", "visitDate", "visitBy", "loiDate", "possessionDate", "siteNumber"];

module.exports = { COLLECTIONS, STAGES, STAGE_STATUSES, NO_EVIDENCE_STAGES, BRANDING_ITEMS, BOARD_FIELDS, READINESS_ITEMS, HEADER_FIELDS };
