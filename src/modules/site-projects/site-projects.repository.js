const { named } = require("../../utils/named-collection");

// Data access for the site-projects module. Services reach MongoDB only through these collection handles.
module.exports = {
  get agreements() {
    return named("agreements");
  },
  get apna_mappings() {
    return named("apna_mappings");
  },
  get applications() {
    return named("applications");
  },
  get atms() {
    return named("atms");
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
  get lois() {
    return named("lois");
  },
  get lookups() {
    return named("lookups");
  },
  get ops_txn() {
    return named("ops_txn");
  },
  get payout_accounts() {
    return named("payout_accounts");
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
  collection: (name) => named(name),
};
