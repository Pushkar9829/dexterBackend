const { Router } = require("express");
const controller = require("./atms.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/atms", requireAuth, requireAction("View", "CRM-02"), controller.getAtms);
router.post("/api/atms", requireAuth, controller.postAtms);
router.patch("/api/atms/:id", requireAuth, controller.patchAtmsById);

module.exports = router;
