const { named } = require("../../utils/named-collection");

// Data access for the companies module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get companies() {
    return named("companies");
  },
  get sessions() {
    return named("sessions");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
