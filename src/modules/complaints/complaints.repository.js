const { named } = require("../../utils/named-collection");

// Data access for the complaints module. Services reach MongoDB only through these collection handles.
module.exports = {
  get atms() {
    return named("atms");
  },
  get companies() {
    return named("companies");
  },
  get complaints() {
    return named("complaints");
  },
  get counters() {
    return named("counters");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get inspections() {
    return named("inspections");
  },
  get lookups() {
    return named("lookups");
  },
  get site_projects() {
    return named("site_projects");
  },
  get tasks() {
    return named("tasks");
  },
  get users() {
    return named("users");
  },
  get visits() {
    return named("visits");
  },
  collection: (name) => named(name),
};
