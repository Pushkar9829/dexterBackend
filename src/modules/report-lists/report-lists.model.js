const COLLECTIONS = ["chargebacks","complaints","employees","franchises","gst_bills","inspections","lookups","mails","ops_cbr1","ops_cbr2","ops_eod","ops_txn","payouts","report_subscriptions","security_deposits"];

const TXN_TYPES = ["nonCash", "cash", "upi", "deposit"];

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const COMPLAINT_DONE = ["Resolved", "Closed"];

const LISTS = {
  "txn-region": { module: "CRM-04", title: "TXN by region" },
  "txn-client": { module: "CRM-04", title: "TXN by client (bank)" },
  "franchise-consolidated": { module: "CRM-04", title: "Consolidated view per franchisee firm" },
  franchises: { module: "CRM-02", title: "Franchises" },
  "axis-icd": { module: "CRM-02", title: "Axis & ICD register" },
  emails: { module: "CRM-05", title: "Emails" },
  inspections: { module: "CRM-05", title: "Inspections" },
  "cbr-eod": { module: "CRM-04", title: "CBR / EOD completeness" },
};

module.exports = { COLLECTIONS, TXN_TYPES, XLSX_MIME, COMPLAINT_DONE, LISTS };
