const COLLECTIONS = ["atms","bank_statements","chargebacks","companies","counters","documents","franchises","gst_bills","lookups","ops_eod","payments","payout_accounts","payouts","security_deposits","tds_letters"];

const CB_KINDS = ["Failed TXN", "Charge back"];

const CB_STATUSES = ["Open", "Under Review", "Accepted", "Rejected", "Closed"];

const CB_NEXT = { Open: ["Under Review", "Accepted", "Rejected"], "Under Review": ["Accepted", "Rejected"], Accepted: ["Closed"], Rejected: [], Closed: [] };

const PAY_KINDS = ["SD", "CLF"];

const PAY_TYPES = ["NEFT", "RTGS", "IMPS"];

const SETTLEMENT_BANKS = ["Axis Indent", "WLA", "ICICI SR", "HDFC", "SBI"];

const SD_MOVES = ["refund", "adjust"];

const SD_ADJUST_AGAINST = ["Charge-back", "Shortage", "Pending payout", "Other dues"];

// Rows saved before the D6 wording change still read "Received/Confirmed" until their next refresh.
const sdFullyReceived = (status) => status === "Received" || status === "Received/Confirmed";

const GST_STATUSES = ["Generated", "Submitted", "Under Processing", "Completed", "Pending"];

const GST_PENDING_AT = ["Pending", "Pending at FR End", "Pending at Hitachi End", "Done"];

const PAYOUT_STATUSES = ["Pending", "Approved", "Processing", "Paid", "On Hold", "Rejected", "Failed"];

const PAYOUT_NEXT = {
  Pending: ["Approved", "On Hold", "Rejected"],
  Approved: ["Processing", "On Hold", "Rejected"],
  Processing: ["Paid", "Failed", "On Hold"],
  "On Hold": ["Pending"],
  Failed: ["Processing"],
  Paid: [],
  Rejected: [],
};

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const BS_ACCOUNT_TYPES = ["", "Axis Indent", "ICICI SR", "Current", "Savings", "OD", "CC"];

const GST_PAYMENT_STATUSES = ["", "Unpaid", "Partly Paid", "Paid"];

module.exports = { COLLECTIONS, CB_KINDS, CB_STATUSES, CB_NEXT, PAY_KINDS, PAY_TYPES, SETTLEMENT_BANKS, SD_MOVES, SD_ADJUST_AGAINST, sdFullyReceived, GST_STATUSES, GST_PENDING_AT, PAYOUT_STATUSES, PAYOUT_NEXT, QUARTERS, MONTH_RE, IFSC_RE, PAN_RE, GSTIN_RE, BS_ACCOUNT_TYPES, GST_PAYMENT_STATUSES };
