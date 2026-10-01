const { named } = require("../../utils/named-collection");

// Data access for the audit module. Services reach MongoDB only through these collection handles.
module.exports = {
  get audit_events() {
    return named("audit_events");
  },
  get companies() {
    return named("companies");
  },
  get lookups() {
    return named("lookups");
  },
  get session_log() {
    return named("session_log");
  },
  get sessions() {
    return named("sessions");
  },
  get tasks() {
    return named("tasks");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
