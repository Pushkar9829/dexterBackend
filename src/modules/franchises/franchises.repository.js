const { named } = require("../../utils/named-collection");

// Data access for the franchises module. Services reach MongoDB only through these collection handles.
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
  get chargebacks() {
    return named("chargebacks");
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
  get gst_bills() {
    return named("gst_bills");
  },
  get lois() {
    return named("lois");
  },
  get payments() {
    return named("payments");
  },
  get payout_accounts() {
    return named("payout_accounts");
  },
  get payouts() {
    return named("payouts");
  },
  get security_deposits() {
    return named("security_deposits");
  },
  get sessions() {
    return named("sessions");
  },
  get sites() {
    return named("sites");
  },
  get tds_letters() {
    return named("tds_letters");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
};
