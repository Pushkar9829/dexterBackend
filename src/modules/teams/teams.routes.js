const { Router } = require("express");
const controller = require("./teams.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/teams", requireAuth, requireAction("View", "CRM-01"), controller.getTeams);
router.post("/api/teams", requireAuth, requireAction("Create", "CRM-01"), controller.postTeams);
router.patch("/api/teams/:id", requireAuth, requireAction("Edit", "CRM-01"), controller.patchTeamsById);

module.exports = router;
