const { named } = require("../../utils/named-collection");

// Data access for the adapters module. Services reach MongoDB only through these collection handles.
module.exports = {
  get adapter_runs() {
    return named("adapter_runs");
  },
  get lookups() {
    return named("lookups");
  },
  get mails() {
    return named("mails");
  },
  collection: (name) => named(name),
};
