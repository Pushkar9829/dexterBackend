const config = require("../../config/env");

const COLLECTIONS = ["companies","sessions","users"];

const MODE = () => String(config.HRMS_ADAPTER || "off").toLowerCase();

const SYSTEM_REQ = { user: { login: "hrms" }, headers: {}, ip: "" };

const LEFT = ["inactive", "terminated", "left", "resigned", "deactivated", "exited"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = { COLLECTIONS, MODE, SYSTEM_REQ, LEFT, EMAIL_RE };
