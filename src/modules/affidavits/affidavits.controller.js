const { handle } = require("../../utils/http");
const affidavitsService = require("./affidavits.service");

module.exports = {
  getAffidavitFormats: handle(affidavitsService.getAffidavitFormats),
  postAffidavitFormats: handle(affidavitsService.postAffidavitFormats),
  patchAffidavitFormatsByIdCurrent: handle(affidavitsService.patchAffidavitFormatsByIdCurrent),
  getAffidavitFormatsByIdFile: handle(affidavitsService.getAffidavitFormatsByIdFile),
};
