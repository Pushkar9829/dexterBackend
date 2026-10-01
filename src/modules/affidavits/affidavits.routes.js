const { Router } = require("express");
const controller = require("./affidavits.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/affidavit-formats", requireAuth, controller.getAffidavitFormats);
router.post("/api/affidavit-formats", requireAuth, controller.postAffidavitFormats);
router.patch("/api/affidavit-formats/:id/current", requireAuth, controller.patchAffidavitFormatsByIdCurrent);
router.get("/api/affidavit-formats/:id/file", requireAuth, controller.getAffidavitFormatsByIdFile);

module.exports = router;
