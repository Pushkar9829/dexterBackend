const { Router } = require("express");
const controller = require("./lookups.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/lookups", requireAuth, controller.getLookups);
router.patch("/api/lookups", requireAuth, requireAction("Edit", "CRM-01"), controller.patchLookups);
router.get("/api/reminders", requireAuth, requireAction("View", "CRM-02"), controller.getReminders);

module.exports = router;
