const { named } = require("../../utils/named-collection");

// Data access for the auth module. Services reach MongoDB only through these collection handles.
module.exports = {
  get companies() {
    return named("companies");
  },
  get franchises() {
    return named("franchises");
  },
  get employees() {
    return named("employees");
  },
  get mfa_tickets() {
    return named("mfa_tickets");
  },
  get session_log() {
    return named("session_log");
  },
  get sessions() {
    return named("sessions");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
