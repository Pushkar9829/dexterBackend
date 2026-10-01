const { Router } = require("express");
const controller = require("./reports.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/reports/meta", requireAuth, controller.getReportsMeta);
router.get("/api/reports/view/:kind", requireAuth, requireAction("View", "CRM-04"), controller.getReportsViewByKind);
router.get("/api/reports/filters", requireAuth, requireAction("View", "CRM-04"), controller.getReportsFilters);
router.get("/api/reports/monthly", requireAuth, requireAction("View", "CRM-04"), controller.getReportsMonthly);
router.put("/api/reports/monthly", requireAuth, controller.putReportsMonthly);
router.put("/api/reports/loading", requireAuth, controller.putReportsLoading);
router.patch("/api/reports/loading/:id/correct", requireAuth, controller.patchReportsLoadingByIdCorrect);

module.exports = router;
