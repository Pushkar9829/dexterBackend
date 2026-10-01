const { named } = require("../../utils/named-collection");

// Data access for the applications module. Services reach MongoDB only through these collection handles.
module.exports = {
  get applications() {
    return named("applications");
  },
  get franchises() {
    return named("franchises");
  },
  get site_projects() {
    return named("site_projects");
  },
  get documents() {
    return named("documents");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
