const { named } = require("./named-collection");

// Data access for shared code outside the feature modules (utils, jobs, adapters, middlewares).
module.exports = {
  get adapter_runs() {
    return named("adapter_runs");
  },
  get atms() {
    return named("atms");
  },
  get audit_events() {
    return named("audit_events");
  },
  get companies() {
    return named("companies");
  },
  get franchises() {
    return named("franchises");
  },
  get projects() {
    return named("projects");
  },
  get session_log() {
    return named("session_log");
  },
  get sessions() {
    return named("sessions");
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
