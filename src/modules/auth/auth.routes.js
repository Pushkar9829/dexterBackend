const { Router } = require("express");
const controller = require("./auth.controller");
const { requireAuth } = require("../../middlewares/rbac");

const { rateLimit } = require("../../middlewares/rateLimit");

const router = Router();

router.post("/api/auth/login", rateLimit("login"), controller.postAuthLogin);
router.post("/api/auth/mfa", rateLimit("mfa"), controller.postAuthMfa);
router.get("/api/auth/me", requireAuth, controller.getAuthMe);
router.post("/api/auth/logout", requireAuth, controller.postAuthLogout);
router.post("/api/auth/forgot", rateLimit("forgot", 20), controller.postAuthForgot);
router.post("/api/auth/reset", rateLimit("reset"), controller.postAuthReset);
router.post("/api/auth/company", requireAuth, controller.postAuthCompany);
router.get("/api/auth/mfa/status", requireAuth, controller.getAuthMfaStatus);
router.post("/api/auth/totp/setup", requireAuth, controller.postAuthTotpSetup);
router.post("/api/auth/totp/enable", requireAuth, controller.postAuthTotpEnable);
router.post("/api/auth/totp/disable", requireAuth, controller.postAuthTotpDisable);
router.post("/api/auth/recovery-codes", requireAuth, controller.postAuthRecoveryCodes);

module.exports = router;
