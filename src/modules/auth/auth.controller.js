const { handle } = require("../../utils/http");
const authService = require("./auth.service");
const companySwitchService = require("./company-switch.service");
const mfaService = require("./mfa.service");

module.exports = {
  postAuthLogin: handle(authService.postAuthLogin),
  postAuthMfa: handle(authService.postAuthMfa),
  getAuthMe: handle(authService.getAuthMe),
  postAuthLogout: handle(authService.postAuthLogout),
  postAuthForgot: handle(authService.postAuthForgot),
  postAuthReset: handle(authService.postAuthReset),
  postAuthCompany: handle(companySwitchService.postAuthCompany),
  getAuthMfaStatus: handle(mfaService.getAuthMfaStatus),
  postAuthTotpSetup: handle(mfaService.postAuthTotpSetup),
  postAuthTotpEnable: handle(mfaService.postAuthTotpEnable),
  postAuthTotpDisable: handle(mfaService.postAuthTotpDisable),
  postAuthRecoveryCodes: handle(mfaService.postAuthRecoveryCodes),
};
