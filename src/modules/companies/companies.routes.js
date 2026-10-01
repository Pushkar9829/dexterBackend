const { Router } = require("express");
const controller = require("./companies.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/companies", requireAuth, controller.getCompanies);
router.post("/api/companies", requireAuth, controller.postCompanies);
router.patch("/api/companies/:id", requireAuth, controller.patchCompaniesById);
router.patch("/api/companies/:id/security", requireAuth, controller.patchCompaniesByIdSecurity);
router.post("/api/company-move", requireAuth, controller.postCompanyMove);

module.exports = router;
