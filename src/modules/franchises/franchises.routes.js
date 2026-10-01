const { Router } = require("express");
const controller = require("./franchises.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/franchises", requireAuth, requireAction("View", "CRM-02"), controller.getFranchises);
router.post("/api/franchises", requireAuth, requireAction("Create", "CRM-02"), controller.postFranchises);
router.patch("/api/franchises/:id", requireAuth, requireAction("Edit", "CRM-02"), controller.patchFranchisesById);
router.get("/api/franchise-360/:id", requireAuth, requireAction("View", "CRM-02"), controller.getFranchise360ById);

module.exports = router;
