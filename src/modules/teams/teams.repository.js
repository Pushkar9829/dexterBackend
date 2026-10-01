const { named } = require("../../utils/named-collection");

// Data access for the teams module. Services reach MongoDB only through these collection handles.
module.exports = {
  get employees() {
    return named("employees");
  },
  get lookups() {
    return named("lookups");
  },
  get tasks() {
    return named("tasks");
  },
  get teams() {
    return named("teams");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
