const { named } = require("../../utils/named-collection");

// Data access for the projects module. Services reach MongoDB only through these collection handles.
module.exports = {
  get projects() {
    return named("projects");
  },
  collection: (name) => named(name),
};
