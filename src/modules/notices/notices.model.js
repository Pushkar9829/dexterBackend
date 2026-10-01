const COLLECTIONS = ["agreements","applications","atms","bank_statements","complaints","documents","franchises","lookups","notices","ops_eod","site_projects","users"];

const KINDS = ["assignment", "sla-warning", "sla-breach", "escalation", "affidavit", "stage", "eod", "task", "legal", "complaint", "reminder", "share", "kyc", "application", "visit", "inspection", "finance", "franchise"];

const COMPLAINT_DONE = ["Resolved", "Closed"];

const CHANNELS = ["in-app", "mail", "sms", "whatsapp"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { COLLECTIONS, KINDS, COMPLAINT_DONE, CHANNELS, EMAIL_RE };
