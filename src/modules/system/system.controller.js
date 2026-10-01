const { handle } = require("../../utils/http");
const systemService = require("./system.service");
const sweepService = require("./sweep.service");

module.exports = {
  getHealth: handle(systemService.getHealth),
  getOpenApi: handle(systemService.getOpenApi),
  postSystemSweep: handle(sweepService.postSystemSweep),
};
