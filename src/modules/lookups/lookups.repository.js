const { named } = require("../../utils/named-collection");

// Data access for the lookups module. Services reach MongoDB only through these collection handles.
module.exports = {
  get applications() {
    return named("applications");
  },
  get documents() {
    return named("documents");
  },
  get lookups() {
    return named("lookups");
  },
  collection: (name) => named(name),
};
