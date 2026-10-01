const path = require("path");
const config = require("../../config/env");

const COLLECTIONS = ["audit_events","companies","lookups","session_log","sessions","tasks","users"];

const AUTH_EVENTS = ["LoginSuccess", "LoginFailure", "LoginPasswordOk", "Logout", "SessionExpiry", "SessionRevoked", "LoginLocked", "LoginUnlocked", "PasswordReset", "CompanySwitched"];

const MIN_RETENTION_DAYS = 30;

const EXPORT_LIMIT = 50000;

const ARCHIVE_DIR = config.AUDIT_ARCHIVE_DIR || path.join(__dirname, "..", "..", "..", "archive");

const CLIENT_EVENTS = { PrintScreen: "PrintScreenPressed", AppHidden: "AppHidden", ReportPrinted: "ReportPrinted" };

module.exports = { COLLECTIONS, AUTH_EVENTS, MIN_RETENTION_DAYS, EXPORT_LIMIT, ARCHIVE_DIR, CLIENT_EVENTS };
