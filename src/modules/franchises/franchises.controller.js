const { handle } = require("../../utils/http");
const franchisesService = require("./franchises.service");

module.exports = {
  getFranchises: handle(franchisesService.getFranchises),
  postFranchises: handle(franchisesService.postFranchises),
  patchFranchisesById: handle(franchisesService.patchFranchisesById),
  getFranchise360ById: handle(franchisesService.getFranchise360ById),
};
