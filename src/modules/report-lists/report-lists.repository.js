const { named } = require("../../utils/named-collection");

// Data access for the report-lists module. Services reach MongoDB only through these collection handles.
module.exports = {
  get chargebacks() {
    return named("chargebacks");
  },
  get complaints() {
    return named("complaints");
  },
  get employees() {
    return named("employees");
  },
  get franchises() {
    return named("franchises");
  },
  get gst_bills() {
    return named("gst_bills");
  },
  get inspections() {
    return named("inspections");
  },
  get lookups() {
    return named("lookups");
  },
  get mails() {
    return named("mails");
  },
  get ops_cbr1() {
    return named("ops_cbr1");
  },
  get ops_cbr2() {
    return named("ops_cbr2");
  },
  get ops_eod() {
    return named("ops_eod");
  },
  get ops_txn() {
    return named("ops_txn");
  },
  get payouts() {
    return named("payouts");
  },
  get security_deposits() {
    return named("security_deposits");
  },
  collection: (name) => named(name),
};
