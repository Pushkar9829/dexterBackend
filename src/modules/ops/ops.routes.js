const { Router } = require("express");
const controller = require("./ops.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/ops/meta", requireAuth, controller.getOpsMeta);
router.get("/api/ops/live-atms", requireAuth, requireAction("View", "CRM-04"), controller.getOpsLiveAtms);
router.get("/api/ops/day", requireAuth, requireAction("View", "CRM-04"), controller.getOpsDay);
router.get("/api/ops/prefill", requireAuth, requireAction("View", "CRM-04"), controller.getOpsPrefill);
router.post("/api/ops/eod/verify-day", requireAuth, controller.postOpsEodVerifyDay);
router.get("/api/ops/txn", requireAuth, requireAction("View", "CRM-04"), controller.getOpsTxn);
router.put("/api/ops/txn", requireAuth, controller.putOpsTxn);
router.post("/api/ops/txn/confirm", requireAuth, controller.postOpsTxnConfirm);
router.get("/api/ops/txn/export", requireAuth, requireAction("View", "CRM-04"), controller.getOpsTxnExport);
router.get("/api/ops/cbr1", requireAuth, requireAction("View", "CRM-04"), controller.getOpsCbr1);
router.put("/api/ops/cbr1", requireAuth, controller.putOpsCbr1);
router.get("/api/ops/cbr2", requireAuth, requireAction("View", "CRM-04"), controller.getOpsCbr2);
router.put("/api/ops/cbr2", requireAuth, controller.putOpsCbr2);
router.get("/api/ops/funding", requireAuth, requireAction("View", "CRM-04"), controller.getOpsFunding);
router.put("/api/ops/funding", requireAuth, controller.putOpsFunding);
router.patch("/api/ops/funding/:id/correct", requireAuth, controller.patchOpsFundingByIdCorrect);
router.get("/api/ops/eod", requireAuth, requireAction("View", "CRM-04"), controller.getOpsEod);
router.put("/api/ops/eod", requireAuth, controller.putOpsEod);
router.post("/api/ops/eod/:id/submit", requireAuth, controller.postOpsEodByIdSubmit);
router.post("/api/ops/eod/:id/verify", requireAuth, controller.postOpsEodByIdVerify);
router.patch("/api/ops/eod/:id/admin-correct", requireAuth, controller.patchOpsEodByIdAdminCorrect);
router.get("/api/ops/overage", requireAuth, requireAction("View", "CRM-04"), controller.getOpsOverage);
router.post("/api/ops/overage", requireAuth, requireAction("Create", "CRM-04"), controller.postOpsOverage);

module.exports = router;
