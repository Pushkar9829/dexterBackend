const { named } = require("../../utils/named-collection");

// Data access for the lois module. Services reach MongoDB only through these collection handles.
module.exports = {
  get lois() {
    return named("lois");
  },
  collection: (name) => named(name),
};
