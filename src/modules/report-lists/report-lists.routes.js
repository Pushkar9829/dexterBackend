const { Router } = require("express");
const controller = require("./report-lists.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/report-lists/meta", requireAuth, controller.getReportListsMeta);
router.get("/api/report-lists/subscriptions", requireAuth, controller.getReportSubscriptions);
router.post("/api/report-lists/subscriptions", requireAuth, controller.postReportSubscriptions);
router.delete("/api/report-lists/subscriptions/:id", requireAuth, controller.deleteReportSubscriptionsById);
router.get("/api/report-lists/:kind", requireAuth, controller.getReportListsByKind);

module.exports = router;
