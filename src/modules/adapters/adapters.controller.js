const { handle } = require("../../utils/http");
const adaptersService = require("./adapters.service");

module.exports = {
  getAdapters: handle(adaptersService.getAdapters),
  patchAdaptersSettings: handle(adaptersService.patchAdaptersSettings),
  postAdaptersByKeyTest: handle(adaptersService.postAdaptersByKeyTest),
};
