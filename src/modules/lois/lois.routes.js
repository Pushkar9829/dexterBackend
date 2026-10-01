const { Router } = require("express");
const controller = require("./lois.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/lois", requireAuth, requireAction("View", "CRM-02"), controller.getLois);
router.post("/api/lois", requireAuth, requireAction("Create", "CRM-02"), controller.postLois);
router.patch("/api/lois/:id", requireAuth, controller.patchLoisById);

module.exports = router;
