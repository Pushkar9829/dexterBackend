const { named } = require("../../utils/named-collection");

// Data access for the finance module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get bank_statements() {
    return named("bank_statements");
  },
  get chargebacks() {
    return named("chargebacks");
  },
  get companies() {
    return named("companies");
  },
  get counters() {
    return named("counters");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get gst_bills() {
    return named("gst_bills");
  },
  get lookups() {
    return named("lookups");
  },
  get ops_eod() {
    return named("ops_eod");
  },
  get payments() {
    return named("payments");
  },
  get payout_accounts() {
    return named("payout_accounts");
  },
  get payouts() {
    return named("payouts");
  },
  get security_deposits() {
    return named("security_deposits");
  },
  get users() {
    return named("users");
  },
  get tds_letters() {
    return named("tds_letters");
  },
  collection: (name) => named(name),
};
