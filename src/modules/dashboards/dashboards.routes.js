const { Router } = require("express");
const controller = require("./dashboards.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/dashboard/:kind", requireAuth, controller.getDashboardByKind);

module.exports = router;
