const { Router } = require("express");
const controller = require("./notices.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/notices", requireAuth, controller.getNotices);
router.get("/api/notices/settings", requireAuth, controller.getNoticesSettings);
router.patch("/api/notices/settings", requireAuth, controller.patchNoticesSettings);
router.patch("/api/notices/:id/read", requireAuth, controller.patchNoticesByIdRead);
router.post("/api/notices/read-all", requireAuth, controller.postNoticesReadAll);

module.exports = router;
