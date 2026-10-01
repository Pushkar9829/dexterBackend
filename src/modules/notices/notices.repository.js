const { named } = require("../../utils/named-collection");

// Data access for the notices module. Services reach MongoDB only through these collection handles.
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
  get bank_statements() {
    return named("bank_statements");
  },
  get complaints() {
    return named("complaints");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get lookups() {
    return named("lookups");
  },
  get notices() {
    return named("notices");
  },
  get ops_eod() {
    return named("ops_eod");
  },
  get site_projects() {
    return named("site_projects");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
