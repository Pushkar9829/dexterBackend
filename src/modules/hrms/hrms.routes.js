const { Router } = require("express");
const controller = require("./hrms.controller");

const router = Router();

router.post("/api/hrms/webhook", controller.postHrmsWebhook);

module.exports = router;
