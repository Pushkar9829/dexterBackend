const { Router } = require("express");
const controller = require("./employees.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/employees", requireAuth, requireAction("View", "CRM-01"), controller.getEmployees);
router.post("/api/employees", requireAuth, requireAction("Create", "CRM-01"), controller.postEmployees);
router.patch("/api/employees/:id", requireAuth, requireAction("Edit", "CRM-01"), controller.patchEmployeesById);

module.exports = router;
