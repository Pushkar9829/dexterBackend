const { handle } = require("../../utils/http");
const reportListsService = require("./report-lists.service");
const subscriptions = require("./report-lists.subscriptions");

module.exports = {
  getReportListsMeta: handle(reportListsService.getReportListsMeta),
  getReportListsByKind: handle(reportListsService.getReportListsByKind),
  getReportSubscriptions: handle(subscriptions.getReportSubscriptions),
  postReportSubscriptions: handle(subscriptions.postReportSubscriptions),
  deleteReportSubscriptionsById: handle(subscriptions.deleteReportSubscriptionsById),
};
