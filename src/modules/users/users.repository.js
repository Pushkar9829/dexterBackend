const { named } = require("../../utils/named-collection");

// Data access for the users module. Services reach MongoDB only through these collection handles.
module.exports = {
  get employees() {
    return named("employees");
  },
  get session_log() {
    return named("session_log");
  },
  get franchises() {
    return named("franchises");
  },
  get projects() {
    return named("projects");
  },
  get sessions() {
    return named("sessions");
  },
  get users() {
    return named("users");
  },
  get lookups() {
    return named("lookups");
  },
  get teams() {
    return named("teams");
  },
  collection: (name) => named(name),
};
