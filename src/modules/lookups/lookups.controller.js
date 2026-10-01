const { handle } = require("../../utils/http");
const lookupsService = require("./lookups.service");

module.exports = {
  getLookups: handle(lookupsService.getLookups),
  patchLookups: handle(lookupsService.patchLookups),
  getReminders: handle(lookupsService.getReminders),
};
