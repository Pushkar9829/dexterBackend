const COLLECTIONS = ["atms","documents","lookups","ops_cbr1","ops_cbr2","ops_eod","ops_funding","ops_txn","overage_deposits","users"];

const DENOS = [100, 200, 500, 1000, 2000];

const DEFAULT_TXN_ENTRY_DAYS = 45;

const CBR1_COLS = ["opening", "dispensed", "purge", "overage", "shortage", "physical", "replenishment", "closing", "switch"];

const CBR1_SIDE_ROWS = ["AQS", "WLACBR"];

const TXN_TYPES = ["nonCash", "cash", "upi", "deposit"];

const TXN_TYPE_NAMES = { "non-cash": "nonCash", noncash: "nonCash", cash: "cash", upi: "upi", deposit: "deposit" };

const CBR2_FIELDS = ["opening", "dispense", "purge", "overage", "shortage", "physical", "loading", "closing", "switchBalance"];

const WLA_FIELDS = ["lastDayDispenseApna", "openingWla", "fundHpy", "withdrawal", "loadingCbr", "frOwnFund"];

const FUNDING_TYPES = ["WLA", "Axis", "ICD"];

const AXIS_FIELDS = ["lastDayDispenseApna", "axisLot1", "axisLot2", "loadingCbr", "frOwnFund"];

const EOD_TIME = "23:00";

module.exports = { COLLECTIONS, DENOS, DEFAULT_TXN_ENTRY_DAYS, CBR1_COLS, CBR1_SIDE_ROWS, TXN_TYPES, TXN_TYPE_NAMES, CBR2_FIELDS, WLA_FIELDS, FUNDING_TYPES, AXIS_FIELDS, EOD_TIME };
