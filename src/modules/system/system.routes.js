const { Router } = require("express");
const controller = require("./system.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/health", controller.getHealth);
router.get("/api/openapi.json", requireAuth, controller.getOpenApi);
router.post("/api/system/sweep", requireAuth, controller.postSystemSweep);

module.exports = router;
