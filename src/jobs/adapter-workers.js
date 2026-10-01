const { logRun, env } = require("../adapters/common");
const { pollImap } = require("../adapters/imap");
const { MODE } = require("../modules/hrms/hrms.model");
const { pullOnce } = require("../modules/hrms/hrms.service");

function startAdapterWorkers() {
  const every = (minutes, key, fn) =>
    setInterval(async () => {
      try {
        const r = await fn();
        if (r && r.ok !== false) await logRun(key, true, r.message || JSON.stringify(r).slice(0, 200));
      } catch (err) {
        await logRun(key, false, err.message).catch(() => null);
      }
    }, minutes * 60 * 1000);
  if (require("../modules/mail/mail.model").TRANSPORT === "smtp") every(5, "mail", async () => {
    const r = await require("../modules/mail/mail.service").drainQueue();
    return { message: r.sent + " sent, " + r.queued + " still queued, " + r.failed + " failed" };
  });
  if (env("MAIL_INBOUND") === "imap") every(Number(env("IMAP_POLL_MINUTES")) || 5, "inbound", pollImap);
  if (MODE() === "pull") every(Number(env("HRMS_PULL_MINUTES")) || 60, "hrms", pullOnce);
}

module.exports = { startAdapterWorkers };
