const { handle } = require("../../utils/http");
const reportsService = require("./reports.service");

module.exports = {
  getReportsMeta: handle(reportsService.getReportsMeta),
  getReportsViewByKind: handle(reportsService.getReportsViewByKind),
  getReportsFilters: handle(reportsService.getReportsFilters),
  getReportsMonthly: handle(reportsService.getReportsMonthly),
  putReportsMonthly: handle(reportsService.putReportsMonthly),
  putReportsLoading: handle(reportsService.putReportsLoading),
  patchReportsLoadingByIdCorrect: handle(reportsService.patchReportsLoadingByIdCorrect),
};
