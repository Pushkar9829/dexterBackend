const { handle } = require("../../utils/http");
const dashboardsService = require("./dashboards.service");

module.exports = {
  getDashboardByKind: handle(dashboardsService.getDashboardByKind),
};
