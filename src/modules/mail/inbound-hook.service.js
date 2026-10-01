const { env, inboundCompany, logRun } = require("../../adapters/common");
const { verifySignature } = require("../hrms/hrms.service");

function verifyWebhook(secret, req) {
  return verifySignature(secret, req);
}

async function postMailInboundHook(ctx) {
  if (env("MAIL_INBOUND") !== "webhook") return { status: 404, body: { error: "not found" } };
  if (!verifyWebhook(env("MAIL_WEBHOOK_SECRET"), ctx)) return { status: 401, body: { error: "bad signature" } };
  const company = await inboundCompany();
  if (!company) return { status: 503, body: { error: "MAIL_INBOUND_COMPANY not set" } };
  const { receiveInbound } = require("./mail.service");
    const { SYSTEM_REQ } = require("./mail.model");
  const r = await receiveInbound({ ...SYSTEM_REQ, user: { login: "mail-webhook", companyId: company._id } }, company._id, ctx.body, { via: "webhook" });
  await logRun("inbound", r.status === 200, r.status === 200 ? "webhook mail " + (r.body.mapped ? "mapped" : "unmapped") : r.body.error);
  return { status: r.status, body: r.body };
}

module.exports = { verifyWebhook, postMailInboundHook };
