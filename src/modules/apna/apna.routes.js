const { Router } = require("express");
const controller = require("./apna.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/apna", requireAuth, requireAction("View", "CRM-02"), controller.getApna);
router.post("/api/apna", requireAuth, requireAction("Create", "CRM-02"), controller.postApna);
router.patch("/api/apna/:id", requireAuth, requireAction("Edit", "CRM-02"), controller.patchApnaById);

module.exports = router;
