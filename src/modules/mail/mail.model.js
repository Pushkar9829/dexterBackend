const config = require("../../config/env");

const COLLECTIONS = ["atms","complaints","documents","franchises","lookups","mail_templates","mails","tracker_rows","users","visits"];

const STATUSES = ["Draft", "Queued", "Sending", "Sent", "Failed", "Bounced", "Retry", "Reply Received"];

// Derived from Sent ticket mail with no reply yet; not stored.
const REPLY_STATES = ["Awaiting Reply", "No Reply"];
const REPLY_WAIT_HOURS = 48;

const BOUNCE_RE = /\b55\d\b|bounce|user unknown|no such user|mailbox (unavailable|not found)|recipient (address )?rejected|does not exist|undeliverable/i;

function replyState(m, now = Date.now()) {
  if (!m || m.direction !== "out" || m.status !== "Sent" || !m.complaintId || m.repliedAt || !m.sentAt) return "";
  return now - new Date(m.sentAt).getTime() < REPLY_WAIT_HOURS * 3600000 ? "Awaiting Reply" : "No Reply";
}

const TEMPLATE_KEYS = ["ack", "kyc-reject", "cbr", "payout", "payout-account", "link-shared", "task-share", "notice", "custom"];

const DEFAULT_TEMPLATES = {
  ack: { name: "Complaint acknowledgement", subject: "Docket {{docket}} — {{atmId}}", body: "Dear {{franchise}},\n\nYour complaint for ATM {{atmId}} is registered with docket number {{docket}}.\nStatus: {{status}}.\n" },
  "kyc-reject": { name: "KYC rejected", subject: "KYC documents need correction", body: "Dear {{franchise}},\n\nSome KYC documents could not be accepted. Please upload corrected copies in the CRM.\n" },
  cbr: { name: "CBR report", subject: "CBR report {{atmId}} {{today}}", body: "Please find the CBR report for ATM {{atmId}} dated {{today}}.\n" },
  payout: { name: "Payout", subject: "Payout update — {{franchise}}", body: "Dear {{franchise}},\n\nYour payout has been processed.\n" },
  "payout-account": { name: "Payout account verified", subject: "Payout account verified — {{franchise}}", body: "The payout account for {{franchise}} has been verified.\n\nAccount name: {{accountName}}\nBank: {{bank}}\nAccount number: {{account}}\nIFSC: {{ifsc}}\nVerified on: {{today}}\n" },
  "link-shared": { name: "Agreement link shared", subject: "Agreement ready to sign — {{franchise}}", body: "Dear {{franchise}},\n\nYour agreement is ready. Please open the link below to review and sign:\n{{link}}\n" },
  "task-share": { name: "Task shared", subject: "Task {{taskNo}} shared with you", body: "{{by}} shared task {{taskNo}} with you: {{title}}.\nDue: {{due}}\n" },
  notice: { name: "CRM notice", subject: "{{title}}", body: "{{body}}\n" },
  custom: { name: "Custom", subject: "", body: "" },
};

const VARIANTS = {
  complaint: { label: "Complaint mail", auto: true },
  calling: { label: "Calling remarks", auto: true, fields: ["atmId", "siteId", "callDate", "calledBy", "remarks"] },
  cbr: { label: "CBR report mail", auto: true },
  penalty: { label: "Penalty", fields: ["atmId", "siteId", "days", "penalty", "remark"] },
  "cheque-pod": { label: "Cheque / POD", fields: ["siteId", "atmId", "type", "frBank", "podFrToF", "operatorChequeNo", "dexterChequeNo", "podToOperator", "acknowledgement", "remark"] },
  pvc: { label: "PVC", fields: ["siteId", "atmId", "pvcDate", "expiry", "remark"] },
};

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const DOCKET_RE = /\bDKT-[A-Z0-9]+-\d{6}-\d{4,}\b/;

const MAX_RETRIES = 5;

const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

const TRANSPORT = config.MAIL_TRANSPORT || (config.NODE_ENV === "production" ? "none" : "demo");

const SYSTEM_REQ = { user: { login: "system" }, headers: {}, ip: "" };

// Bcc stays with the mail desk; everyone else sees the mail without it.
function toPublic(m, desk) {
  if (!m || desk) return m;
  const { bcc, ...rest } = m;
  return rest;
}

module.exports = { toPublic, COLLECTIONS, STATUSES, REPLY_STATES, REPLY_WAIT_HOURS, BOUNCE_RE, replyState, TEMPLATE_KEYS, DEFAULT_TEMPLATES, VARIANTS, EMAIL_RE, DOCKET_RE, MAX_RETRIES, MAX_ATTACH_BYTES, TRANSPORT, SYSTEM_REQ };
