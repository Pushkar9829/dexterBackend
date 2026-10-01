const { handle } = require("../../utils/http");
const loisService = require("./lois.service");

module.exports = {
  getLois: handle(loisService.getLois),
  postLois: handle(loisService.postLois),
  patchLoisById: handle(loisService.patchLoisById),
};
