const { Router } = require("express");
const controller = require("./sites.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/sites", requireAuth, requireAction("View", "CRM-02"), controller.getSites);
router.post("/api/sites", requireAuth, requireAction("Create", "CRM-02"), controller.postSites);
router.patch("/api/sites/:id", requireAuth, requireAction("Edit", "CRM-02"), controller.patchSitesById);

module.exports = router;
