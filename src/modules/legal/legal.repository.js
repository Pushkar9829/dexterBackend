const { named } = require("../../utils/named-collection");

// Data access for the legal module. Services reach MongoDB only through these collection handles.
module.exports = {
  get applications() {
    return named("applications");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get register_columns() {
    return named("register_columns");
  },
  collection: (name) => named(name),
};
