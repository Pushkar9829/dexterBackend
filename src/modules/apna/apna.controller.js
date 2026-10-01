const { handle } = require("../../utils/http");
const apnaService = require("./apna.service");

module.exports = {
  getApna: handle(apnaService.getApna),
  postApna: handle(apnaService.postApna),
  patchApnaById: handle(apnaService.patchApnaById),
};
