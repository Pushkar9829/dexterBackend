const { Router } = require("express");
const controller = require("./agreements.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/agreements", requireAuth, requireAction("View", "CRM-02"), controller.getAgreements);
router.post("/api/agreements", requireAuth, requireAction("Create", "CRM-02"), controller.postAgreements);
router.patch("/api/agreements/:id", requireAuth, controller.patchAgreementsById);

module.exports = router;
