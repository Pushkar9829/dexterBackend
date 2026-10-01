const { named } = require("../../utils/named-collection");

// Data access for the imports module. Services reach MongoDB only through these collection handles.
module.exports = {
  get import_batches() {
    return named("import_batches");
  },
  collection: (name) => named(name),
};
