const { named } = require("../../utils/named-collection");

// Data access for the sites module. Services reach MongoDB only through these collection handles.
module.exports = {
  get franchises() {
    return named("franchises");
  },
  get sites() {
    return named("sites");
  },
  collection: (name) => named(name),
};
