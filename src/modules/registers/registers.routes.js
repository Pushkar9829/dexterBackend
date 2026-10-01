const { Router } = require("express");
const controller = require("./registers.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/register-columns", requireAuth, controller.getRegisterColumns);
router.patch("/api/registers/:register/:id/extra", requireAuth, controller.patchRegistersByRegisterByIdExtra);
router.get("/api/registers/:register/:id/file/:docId", requireAuth, controller.getRegistersByRegisterByIdFileByDocId);
router.post("/api/register-columns", requireAuth, controller.postRegisterColumns);
router.delete("/api/register-columns/:id", requireAuth, controller.deleteRegisterColumnsById);

module.exports = router;
