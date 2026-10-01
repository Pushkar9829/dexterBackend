const { handle } = require("../../utils/http");
const agreementsService = require("./agreements.service");

module.exports = {
  getAgreements: handle(agreementsService.getAgreements),
  postAgreements: handle(agreementsService.postAgreements),
  patchAgreementsById: handle(agreementsService.patchAgreementsById),
};
