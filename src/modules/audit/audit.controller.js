const { handle } = require("../../utils/http");
const auditService = require("./audit.service");

module.exports = {
  getAudit: handle(auditService.getAudit),
  getAuditMeta: handle(auditService.getAuditMeta),
  getAuditExport: handle(auditService.getAuditExport),
  patchAuditSettings: handle(auditService.patchAuditSettings),
  postAuditClientEvent: handle(auditService.postAuditClientEvent),
  getAnalyticsSessions: handle(auditService.getAnalyticsSessions),
  getAnalyticsSessionsByUserId: handle(auditService.getAnalyticsSessionsByUserId),
  deleteAnalyticsSessionsBySessionId: handle(auditService.deleteAnalyticsSessionsBySessionId),
};
