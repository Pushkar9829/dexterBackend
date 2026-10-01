const { SESSION_IDLE_MINUTES } = require("../config/env");
const { purgeAudit, closeStaleSessions } = require("../modules/audit/audit.service");
const { startAdapterWorkers } = require("./adapter-workers");
const { sweepAll } = require("./sweep");

// Background timers: task/notice/complaint sweep, audit retention, idle-session close, and the adapter pollers.
function startJobs() {
  setInterval(sweepAll, 5 * 60 * 1000);
  setInterval(() => purgeAudit().catch((err) => console.error("audit purge failed", err.message)), 60 * 60 * 1000);
  setInterval(() => closeStaleSessions(SESSION_IDLE_MINUTES).catch((err) => console.error("session close failed", err.message)), 10 * 60 * 1000);
  setTimeout(sweepAll, 10 * 1000);
  startAdapterWorkers();
}

module.exports = { startJobs };
