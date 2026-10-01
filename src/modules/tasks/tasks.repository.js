const { named } = require("../../utils/named-collection");

// Data access for the tasks module. Services reach MongoDB only through these collection handles.
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
  get employees() {
    return named("employees");
  },
  get franchises() {
    return named("franchises");
  },
  get lookups() {
    return named("lookups");
  },
  get site_projects() {
    return named("site_projects");
  },
  get task_templates() {
    return named("task_templates");
  },
  get tasks() {
    return named("tasks");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
