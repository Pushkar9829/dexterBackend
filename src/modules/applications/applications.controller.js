const { handle } = require("../../utils/http");
const applicationsService = require("./applications.service");

module.exports = {
  getApplications: handle(applicationsService.getApplications),
  postApplications: handle(applicationsService.postApplications),
  patchApplicationsById: handle(applicationsService.patchApplicationsById),
};
