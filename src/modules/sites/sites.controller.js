const { handle } = require("../../utils/http");
const sitesService = require("./sites.service");

module.exports = {
  getSites: handle(sitesService.getSites),
  postSites: handle(sitesService.postSites),
  patchSitesById: handle(sitesService.patchSitesById),
};
