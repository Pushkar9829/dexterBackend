const { named } = require("../../utils/named-collection");

// Data access for the employees module. Services reach MongoDB only through these collection handles.
module.exports = {
  get employees() {
    return named("employees");
  },
  get sessions() {
    return named("sessions");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
