const { Router } = require("express");
const controller = require("./imports.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/imports/templates", requireAuth, controller.getImportsTemplates);
router.post("/api/imports", requireAuth, controller.postImports);
router.get("/api/imports", requireAuth, requireAction("View", "CRM-04"), controller.getImports);
router.get("/api/imports/:id/original", requireAuth, controller.getImportsByIdOriginal);
router.get("/api/imports/:id/errors", requireAuth, controller.getImportsByIdErrors);

module.exports = router;
