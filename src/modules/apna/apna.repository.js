const { named } = require("../../utils/named-collection");

// Data access for the apna module. Services reach MongoDB only through these collection handles.
module.exports = {
  get apna_mappings() {
    return named("apna_mappings");
  },
  get franchises() {
    return named("franchises");
  },
  collection: (name) => named(name),
};
