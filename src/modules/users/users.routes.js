const { Router } = require("express");
const controller = require("./users.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/users", requireAuth, requireAction("View", "CRM-01"), controller.getUsers);
router.post("/api/users", requireAuth, requireAction("Create", "CRM-01"), controller.postUsers);
router.patch("/api/users/:id/activate", requireAuth, requireAction("Edit", "CRM-01"), controller.patchUsersByIdActivate);
router.post("/api/users/:id/reset-password", requireAuth, requireAction("Edit", "CRM-01"), controller.postUsersByIdResetPassword);
router.patch("/api/users/:id/unlock", requireAuth, requireAction("Edit", "CRM-01"), controller.patchUsersByIdUnlock);
router.patch("/api/users/:id", requireAuth, requireAction("Edit", "CRM-01"), controller.patchUsersById);
router.get("/api/role-templates", requireAuth, requireAction("View", "CRM-01"), controller.getRoleTemplates);
router.put("/api/role-templates", requireAuth, requireAction("Edit", "CRM-01"), controller.putRoleTemplates);

module.exports = router;
