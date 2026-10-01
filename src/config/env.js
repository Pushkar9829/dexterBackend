// Every environment variable the API reads, in one place. Raw values are read on access (tests and scripts may set
// process.env at run time); the settings below are parsed once at start-up.
// Values come from crm/backend/.env when present; variables already set in the real environment win.

const fs = require("fs");
const path = require("path");

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, "..", "..", ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 60;
const MFA_MAX_ATTEMPTS = 5;
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 5;
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES) || 15;
const DEMO_OTP = process.env.NODE_ENV !== "production" && process.env.DEMO_OTP !== "off";
const PORT = Number(process.env.PORT) || 4000;
const AUTH_RATE_PER_MIN = Number(process.env.AUTH_RATE_PER_MIN) || 100;

const NAMES = [
  "AUDIT_ARCHIVE_DIR",
  "AUDIT_PURGE_ORPHANS",
  "CHAT_GATEWAY_TOKEN",
  "CHAT_GATEWAY_URL",
  "CHAT_TEMPLATE",
  "CORS_ORIGINS",
  "FILE_STORE",
  "HRMS_ADAPTER",
  "HRMS_COMPANY",
  "HRMS_PULL_MINUTES",
  "HRMS_TOKEN",
  "HRMS_URL",
  "HRMS_WEBHOOK_SECRET",
  "IDCHECK_PROVIDER",
  "IDCHECK_TIMEOUT_MS",
  "IDCHECK_TOKEN",
  "IDCHECK_URL",
  "IMAP_HOST",
  "IMAP_MAILBOX",
  "IMAP_PASS",
  "IMAP_POLL_MINUTES",
  "IMAP_PORT",
  "IMAP_TLS_INSECURE",
  "IMAP_USER",
  "MAIL_FROM",
  "MAIL_INBOUND",
  "MAIL_INBOUND_COMPANY",
  "MAIL_TRANSPORT",
  "MAIL_WEBHOOK_SECRET",
  "MAX_FILE_MB",
  "MAX_VIDEO_MB",
  "MFA_CHANNEL",
  "MONGO_DB",
  "MONGO_URL",
  "NODE_ENV",
  "RECOVERY_CODE_DAYS",
  "SESSION_SECRET",
  "SMS_GATEWAY_TOKEN",
  "SMS_GATEWAY_URL",
  "SMS_SENDER_ID",
  "SMTP_ALLOW_PLAIN",
  "SMTP_HELO",
  "SMTP_HOST",
  "SMTP_PASS",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_TIMEOUT_MS",
  "SMTP_TLS_INSECURE",
  "SMTP_USER",
  "TOTP_ISSUER",
  "TRUST_PROXY",
];

const config = { SESSION_IDLE_MINUTES, MFA_MAX_ATTEMPTS, LOGIN_MAX_FAILS, LOGIN_LOCK_MINUTES, DEMO_OTP, PORT, AUTH_RATE_PER_MIN };
for (const name of NAMES) Object.defineProperty(config, name, { enumerable: true, get: () => process.env[name] });

module.exports = config;
