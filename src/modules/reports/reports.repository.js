const { named } = require("../../utils/named-collection");

// Data access for the reports module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get ops_cbr1() {
    return named("ops_cbr1");
  },
  get ops_funding() {
    return named("ops_funding");
  },
  get ops_loading() {
    return named("ops_loading");
  },
  get ops_monthly() {
    return named("ops_monthly");
  },
  collection: (name) => named(name),
};
