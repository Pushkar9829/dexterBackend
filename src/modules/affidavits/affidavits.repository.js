const { named } = require("../../utils/named-collection");

// Data access for the affidavits module. Services reach MongoDB only through these collection handles.
module.exports = {
  get affidavit_formats() {
    return named("affidavit_formats");
  },
  collection: (name) => named(name),
};
