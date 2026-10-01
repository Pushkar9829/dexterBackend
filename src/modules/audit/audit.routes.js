const { Router } = require("express");
const controller = require("./audit.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/audit", requireAuth, controller.getAudit);
router.get("/api/audit/meta", requireAuth, controller.getAuditMeta);
router.get("/api/audit/export", requireAuth, controller.getAuditExport);
router.patch("/api/audit/settings", requireAuth, controller.patchAuditSettings);
router.post("/api/audit/client-event", requireAuth, controller.postAuditClientEvent);
router.get("/api/analytics/sessions", requireAuth, controller.getAnalyticsSessions);
router.get("/api/analytics/sessions/:userId", requireAuth, controller.getAnalyticsSessionsByUserId);
router.delete("/api/analytics/sessions/:sessionId", requireAuth, controller.deleteAnalyticsSessionsBySessionId);

module.exports = router;
