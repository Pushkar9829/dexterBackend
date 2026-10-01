const { named } = require("../../utils/named-collection");

// Data access for the system module. Services reach MongoDB only through these collection handles.
module.exports = {
  collection: (name) => named(name),
};
