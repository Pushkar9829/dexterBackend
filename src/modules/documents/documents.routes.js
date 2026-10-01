const { Router } = require("express");
const controller = require("./documents.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/documents", requireAuth, requireAction("View", "CRM-02"), controller.getDocuments);
router.post("/api/documents", requireAuth, requireAction("Create", "CRM-02"), controller.postDocuments);
router.get("/api/documents/:id/file", requireAuth, controller.getDocumentsByIdFile);
router.patch("/api/documents/:id/verify", requireAuth, controller.patchDocumentsByIdVerify);
router.patch("/api/documents/:id/remarks", requireAuth, controller.patchDocumentsByIdRemarks);
router.delete("/api/documents/:id", requireAuth, controller.deleteDocumentsById);
router.post("/api/documents/:id/id-check", requireAuth, controller.postDocumentsByIdIdCheck);

module.exports = router;
