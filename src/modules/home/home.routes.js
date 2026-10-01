const { Router } = require("express");
const controller = require("./home.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/home/summary", requireAuth, controller.getHomeSummary);

module.exports = router;
