const crypto = require("crypto");
const config = require("../../config/env");

const KEY = crypto.createHash("sha256").update(config.SESSION_SECRET || "advocateflow-local-secret").digest();

const ISSUER = config.TOTP_ISSUER || "Dexter CRM";

const RECOVERY_DAYS = Number(config.RECOVERY_CODE_DAYS) || 180;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

module.exports = { KEY, ISSUER, RECOVERY_DAYS, B32 };
