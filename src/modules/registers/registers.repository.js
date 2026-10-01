const { named } = require("../../utils/named-collection");

// Data access for the registers module. Services reach MongoDB only through these collection handles.
module.exports = {
  get documents() {
    return named("documents");
  },
  get register_columns() {
    return named("register_columns");
  },
  collection: (name) => named(name),
};
