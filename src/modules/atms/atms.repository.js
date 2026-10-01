const { named } = require("../../utils/named-collection");

// Data access for the atms module. Services reach MongoDB only through these collection handles.
module.exports = {
  get agreements() {
    return named("agreements");
  },
  get applications() {
    return named("applications");
  },
  get atms() {
    return named("atms");
  },
  get franchises() {
    return named("franchises");
  },
  get lois() {
    return named("lois");
  },
  get projects() {
    return named("projects");
  },
  get site_projects() {
    return named("site_projects");
  },
  get sites() {
    return named("sites");
  },
  collection: (name) => named(name),
};
