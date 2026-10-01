const { handle } = require("../../utils/http");
const atmsService = require("./atms.service");

module.exports = {
  getAtms: handle(atmsService.getAtms),
  postAtms: handle(atmsService.postAtms),
  patchAtmsById: handle(atmsService.patchAtmsById),
};
