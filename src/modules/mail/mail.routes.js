const { Router } = require("express");
const controller = require("./mail.controller");
const { requireAction, requireAuth } = require("../../middlewares/rbac");

const view = requireAction("View", "CRM-05");

const router = Router();

router.get("/api/mail/meta", requireAuth, view, controller.getMailMeta);
router.post("/api/mail/mailbox", requireAuth, view, controller.postMailMailbox);
router.put("/api/mail/templates/:key", requireAuth, controller.putMailTemplatesByKey);
router.put("/api/mail/signature", requireAuth, controller.putMailSignature);
router.post("/api/mail/render", requireAuth, view, controller.postMailRender);
router.get("/api/mail", requireAuth, view, controller.getMail);
router.post("/api/mail", requireAuth, view, controller.postMail);
router.patch("/api/mail/:id", requireAuth, view, controller.patchMailById);
router.post("/api/mail/inbound", requireAuth, view, controller.postMailInbound);
router.patch("/api/mail/:id/map", requireAuth, view, controller.patchMailByIdMap);
router.post("/api/mail/:id/ticket", requireAuth, view, controller.postMailByIdTicket);
router.post("/api/mail/:id/reply", requireAuth, view, controller.postMailByIdReply);
router.get("/api/mail/tracker/:variant", requireAuth, view, controller.getMailTrackerByVariant);
router.post("/api/mail/tracker/:variant", requireAuth, view, controller.postMailTrackerByVariant);
router.patch("/api/mail/tracker-row/:id", requireAuth, view, controller.patchMailTrackerRowById);
router.post("/api/mail/inbound-hook", controller.postMailInboundHook);

module.exports = router;
