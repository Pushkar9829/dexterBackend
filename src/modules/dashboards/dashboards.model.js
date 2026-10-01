const COLLECTIONS = ["agreements","applications","atms","bank_statements","chargebacks","complaints","franchises","gst_bills","inspections","ops_cbr1","ops_cbr2","ops_eod","ops_funding","ops_txn","payments","payouts","projects","security_deposits","site_projects","tasks","visits"];

const KINDS = { overview: "CRM-07", complaints: "CRM-05", projects: "CRM-03", ops: "CRM-04", finance: "CRM-04", tasks: "CRM-06", health: "CRM-07" };

const COMPLAINT_DONE = ["Resolved", "Closed"];

const TASK_DONE = ["Completed", "Closed"];

const TXN_TYPES = ["nonCash", "cash", "upi", "deposit"];

const IST = 330 * 60000;

module.exports = { COLLECTIONS, KINDS, COMPLAINT_DONE, TASK_DONE, TXN_TYPES, IST };
