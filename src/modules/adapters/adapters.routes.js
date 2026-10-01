const { Router } = require("express");
const controller = require("./adapters.controller");
const { requireAuth } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/adapters", requireAuth, controller.getAdapters);
router.patch("/api/adapters/settings", requireAuth, controller.patchAdaptersSettings);
router.post("/api/adapters/:key/test", requireAuth, controller.postAdaptersByKeyTest);

module.exports = router;
