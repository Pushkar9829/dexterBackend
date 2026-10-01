const { Router } = require("express");
const controller = require("./site-projects.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/site-projects/meta", requireAuth, controller.getSiteProjectsMeta);
router.get("/api/site-projects", requireAuth, requireAction("View", "CRM-03"), controller.getSiteProjects);
router.get("/api/site-projects/:id", requireAuth, requireAction("View", "CRM-03"), controller.getSiteProjectsById);
router.post("/api/site-projects", requireAuth, requireAction("Create", "CRM-03"), controller.postSiteProjects);
router.patch("/api/site-projects/:id", requireAuth, controller.patchSiteProjectsById);
router.patch("/api/site-projects/:id/stages/:idx", requireAuth, controller.patchSiteProjectsByIdStagesByIdx);
router.post("/api/site-projects/:id/stages/:idx/approve", requireAuth, controller.postSiteProjectsByIdStagesByIdxApprove);
router.post("/api/site-projects/:id/pptx", requireAuth, controller.postSiteProjectsByIdPptx);

module.exports = router;
