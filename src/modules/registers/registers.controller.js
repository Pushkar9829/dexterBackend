const { handle } = require("../../utils/http");
const registersService = require("./registers.service");

module.exports = {
  getRegisterColumns: handle(registersService.getRegisterColumns),
  patchRegistersByRegisterByIdExtra: handle(registersService.patchRegistersByRegisterByIdExtra),
  getRegistersByRegisterByIdFileByDocId: handle(registersService.getRegistersByRegisterByIdFileByDocId),
  postRegisterColumns: handle(registersService.postRegisterColumns),
  deleteRegisterColumnsById: handle(registersService.deleteRegisterColumnsById),
};
