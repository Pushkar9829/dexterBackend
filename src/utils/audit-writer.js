const repo = require("./shared.repository");

async function writeAudit(ctx, event, extra) {
  const user = ctx.user || {};
  await repo.audit_events.insert({
    event,
    userId: user._id || null,
    login: user.login || extra.login || null,
    companyId: extra.companyId || user.companyId || null,
    ip: ctx.ip || ctx.headers["x-forwarded-for"] || "",
    device: String(ctx.headers["user-agent"] || "").slice(0, 200),
    at: new Date(),
    module: extra.module || "",
    recordId: extra.recordId || null,
    before: extra.before || null,
    after: extra.after || null,
    work: extra.work || "",
  });
}

function clientIp(ctx) {
  return (ctx.headers["x-forwarded-for"] || ctx.socket.remoteAddress || "").toString();
}

module.exports = { writeAudit, clientIp };
