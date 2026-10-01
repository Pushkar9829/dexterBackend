const { named } = require("../../utils/named-collection");

// Data access for the mail module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get complaints() {
    return named("complaints");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get lookups() {
    return named("lookups");
  },
  get mail_templates() {
    return named("mail_templates");
  },
  get mails() {
    return named("mails");
  },
  get tracker_rows() {
    return named("tracker_rows");
  },
  get users() {
    return named("users");
  },
  get visits() {
    return named("visits");
  },
  collection: (name) => named(name),
};
