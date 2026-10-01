const { Router } = require("express");
const controller = require("./applications.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/applications", requireAuth, requireAction("View", "CRM-02"), controller.getApplications);
router.post("/api/applications", requireAuth, requireAction("Create", "CRM-02"), controller.postApplications);
router.patch("/api/applications/:id", requireAuth, controller.patchApplicationsById);

module.exports = router;
