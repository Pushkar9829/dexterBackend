const { named } = require("../../utils/named-collection");

// Data access for the home module. Services reach MongoDB only through these collection handles.
module.exports = {
  get applications() {
    return named("applications");
  },
  get ops_eod() {
    return named("ops_eod");
  },
  collection: (name) => named(name),
};
