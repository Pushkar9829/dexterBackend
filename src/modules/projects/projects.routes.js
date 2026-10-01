const { Router } = require("express");
const controller = require("./projects.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.patch("/api/projects/:id", requireAuth, requireAction("Edit", "CRM-01"), controller.patchProjectsById);
router.get("/api/projects", requireAuth, controller.getProjects);
router.post("/api/projects", requireAuth, requireAction("Create", "CRM-01"), controller.postProjects);

module.exports = router;
