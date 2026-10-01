const { named } = require("../../utils/named-collection");

// Data access for the dashboards module. Services reach MongoDB only through these collection handles.
module.exports = {
  get agreements() {
    return named("agreements");
  },
  get applications() {
    return named("applications");
  },
  get atms() {
    return named("atms");
  },
  get bank_statements() {
    return named("bank_statements");
  },
  get chargebacks() {
    return named("chargebacks");
  },
  get complaints() {
    return named("complaints");
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
  get ops_cbr1() {
    return named("ops_cbr1");
  },
  get ops_cbr2() {
    return named("ops_cbr2");
  },
  get ops_eod() {
    return named("ops_eod");
  },
  get ops_funding() {
    return named("ops_funding");
  },
  get ops_txn() {
    return named("ops_txn");
  },
  get payments() {
    return named("payments");
  },
  get payouts() {
    return named("payouts");
  },
  get projects() {
    return named("projects");
  },
  get security_deposits() {
    return named("security_deposits");
  },
  get site_projects() {
    return named("site_projects");
  },
  get tasks() {
    return named("tasks");
  },
  get visits() {
    return named("visits");
  },
  collection: (name) => named(name),
};
