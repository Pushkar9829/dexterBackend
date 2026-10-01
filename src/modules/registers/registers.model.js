const COLLECTIONS = ["documents","register_columns"];

const REGISTERS = {
  agreement: "agreements",
  loi: "lois",
  site: "sites",
  atm: "atms",
  apna: "apna_mappings",
  franchise: "franchises",
  employee: "employees",
  complaint: "complaints",
  txn: "ops_txn",
  payment: "payments",
  bankStatement: "bank_statements",
  tds: "tds_letters",
  gstBill: "gst_bills",
  payout: "payouts",
};

const REGISTER_MODULE = { complaint: "CRM-05", txn: "CRM-04", payment: "CRM-04", bankStatement: "CRM-04", tds: "CRM-04", gstBill: "CRM-04", payout: "CRM-04", employee: "CRM-01" };

const COLUMN_TYPES = ["text", "date", "number", "status", "file"];

module.exports = { COLLECTIONS, REGISTERS, REGISTER_MODULE, COLUMN_TYPES };
