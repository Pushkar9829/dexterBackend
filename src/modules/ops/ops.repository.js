const { named } = require("../../utils/named-collection");

// Data access for the ops module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get documents() {
    return named("documents");
  },
  get lookups() {
    return named("lookups");
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
  get overage_deposits() {
    return named("overage_deposits");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
