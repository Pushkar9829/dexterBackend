const COLLECTIONS = ["atms","documents","franchises","ops_cbr1","ops_funding","ops_loading","ops_monthly"];

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MODELS = ["FFM", "SF"];

const FUND_SPLIT = ["selfFund", "monthlyAdditional", "weeklyAdditional"];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const KINDS = ["cbr1", "cbr2", "cbr3-wla", "cbr3-axis", "overage", "ffm-eod", "sf-loading", "mobile-app", "mobile-loading", "dlr2", "dlr3"];

const CBR1_COLS = ["opening", "dispensed", "purge", "overage", "shortage", "physical", "replenishment", "closing", "switch"];

const CBR1_LABELS = { opening: "Opening", dispensed: "Dispensed", purge: "Purge", overage: "Overage", shortage: "Shortage", physical: "Physical before replenishment", replenishment: "Replenishment", closing: "Closing", switch: "Switch Counter" };

const SF_NOTE = "Total Funding = Self Cash Loading Fund + Monthly Additional Loading Fund + Weekly Additional Loading Fund";

module.exports = { COLLECTIONS, XLSX_MIME, MONTH_RE, MODELS, FUND_SPLIT, MONTH_NAMES, KINDS, CBR1_COLS, CBR1_LABELS, SF_NOTE };
