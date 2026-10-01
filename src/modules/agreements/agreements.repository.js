const { named } = require("../../utils/named-collection");

// Data access for the agreements module. Services reach MongoDB only through these collection handles.
module.exports = {
  get agreements() {
    return named("agreements");
  },
  get franchises() {
    return named("franchises");
  },
  get lookups() {
    return named("lookups");
  },
  get register_columns() {
    return named("register_columns");
  },
  collection: (name) => named(name),
};
