const { env, EMAIL_RE, postJson, logRun } = require("../../adapters/common");
const { pollImap } = require("../../adapters/imap");
const { sendSms, sendChat, sendCode } = require("../../adapters/messaging");
const { smtpConfig, sendMailNow } = require("../../adapters/smtp");
const repo = require("./adapters.repository");
const { MODE } = require("../hrms/hrms.model");
const { pullOnce } = require("../hrms/hrms.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

const isAdminLayer = (u) => ["Admin", "DexterIndiaCompanyTeam"].includes(u.hierarchy);

// ---------- status cards ----------

async function adapterStatus(companyId) {
  const runs = Object.fromEntries((await repo.adapter_runs.list({})).map((r) => [r.key, { at: r.at, result: (r.ok ? "ok: " : "failed: ") + r.result }]));
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const transport = require("../mail/mail.model").TRANSPORT;
  const queued = await repo.mails.count({ companyId, direction: "out", status: { $in: ["Queued", "Retry"] } });
  const smtp = smtpConfig();
  const inbound = env("MAIL_INBOUND") || "off";
  const mode = MODE();
  const mfa = env("MFA_CHANNEL") || "demo";
  return [
    { key: "mail", label: "Outgoing mail (SMTP)", on: transport === "smtp", detail: transport === "smtp" ? smtp.host + ":" + smtp.port + (smtp.secure ? " TLS" : " STARTTLS") + " as " + (smtp.user || "no auth") + " — " + queued + " queued" : "MAIL_TRANSPORT=" + transport + " — " + queued + " queued" },
    { key: "inbound", label: "Incoming mail", on: inbound === "imap" || inbound === "webhook", detail: inbound === "imap" ? "IMAP " + env("IMAP_HOST") + " every " + (Number(env("IMAP_POLL_MINUTES")) || 5) + " min" : inbound === "webhook" ? "Signed webhook POST /api/mail/inbound-hook" : "MAIL_INBOUND=off — replies are recorded by hand" },
    { key: "sms", label: "SMS gateway", on: !!env("SMS_GATEWAY_URL"), detail: env("SMS_GATEWAY_URL") ? new URL(env("SMS_GATEWAY_URL")).host : "SMS_GATEWAY_URL not set" },
    { key: "chat", label: "WhatsApp gateway", on: !!env("CHAT_GATEWAY_URL"), detail: env("CHAT_GATEWAY_URL") ? new URL(env("CHAT_GATEWAY_URL")).host : "CHAT_GATEWAY_URL not set" },
    { key: "otp", label: "One-time codes", on: mfa !== "demo", detail: "MFA_CHANNEL=" + mfa + (mfa === "demo" ? " — codes are shown on screen" : "") },
    { key: "idcheck", label: "PAN / Aadhaar / DL check", on: !!env("IDCHECK_URL"), detail: env("IDCHECK_URL") ? (env("IDCHECK_PROVIDER") || new URL(env("IDCHECK_URL")).host) : "IDCHECK_URL not set" },
    { key: "hrms", label: "HRMS sync", on: mode !== "off", detail: "HRMS_ADAPTER=" + mode + (mode === "pull" ? " every " + (Number(env("HRMS_PULL_MINUTES")) || 60) + " min" : mode === "webhook" ? " — POST /api/hrms/webhook" : "") },
    { key: "ppt", label: "Project PPT mail", on: !!(lu.pptMailTo || []).length, detail: (lu.pptMailTo || []).length ? "Mails to " + lu.pptMailTo.join(", ") : "No recipients set — PPT can still be downloaded" },
  ].map((a) => ({ ...a, lastRun: runs[a.key] || null }));
}

async function runTest(key, req) {
  const to = String(req.body.to || "").trim();
  if (key === "mail") {
    if (require("../mail/mail.model").TRANSPORT !== "smtp") return { ok: false, message: "not configured (MAIL_TRANSPORT is not smtp)" };
    if (!EMAIL_RE.test(to)) return { ok: false, message: "enter an email address" };
    await sendMailNow(to, "Dexter CRM test mail", "This is a test mail from the Dexter CRM mail adapter.");
    const drained = await require("../mail/mail.service").drainQueue();
    return { ok: true, message: "test mail sent to " + to + "; queue: " + drained.sent + " sent, " + drained.queued + " still queued" };
  }
  if (key === "inbound") {
    if (env("MAIL_INBOUND") === "webhook") return { ok: !!env("MAIL_WEBHOOK_SECRET"), message: env("MAIL_WEBHOOK_SECRET") ? "webhook ready" : "not configured (MAIL_WEBHOOK_SECRET not set)" };
    return pollImap();
  }
  if (key === "sms" || key === "chat") {
    const r = await (key === "sms" ? sendSms : sendChat)(to, "Dexter CRM test message");
    return { ok: r.ok, message: r.ok ? "sent to " + to + (r.ref ? " (" + r.ref + ")" : "") : r.error.includes("configured") ? "not configured (" + r.error + ")" : r.error };
  }
  if (key === "otp") {
    const channel = env("MFA_CHANNEL") || "demo";
    if (channel === "demo" || channel === "totp") return { ok: false, message: "not configured (MFA_CHANNEL is " + channel + ")" };
    const r = await sendCode(channel, req.user, "000000", "test");
    return { ok: r.ok, message: r.ok ? "test code sent by " + channel : r.error };
  }
  if (key === "idcheck") {
    if (!env("IDCHECK_URL")) return { ok: false, message: "not configured (IDCHECK_URL not set)" };
    await postJson(env("IDCHECK_URL"), { test: true }, env("IDCHECK_TOKEN"), Number(env("IDCHECK_TIMEOUT_MS")) || 15000);
    return { ok: true, message: "ID check service answered" };
  }
  if (key === "hrms") {
    if (MODE() === "webhook") return { ok: !!env("HRMS_WEBHOOK_SECRET"), message: env("HRMS_WEBHOOK_SECRET") ? "webhook ready" : "not configured (HRMS_WEBHOOK_SECRET not set)" };
    return pullOnce();
  }
  if (key === "ppt") {
    const lu = (await repo.lookups.findOne({ companyId: oid(req.user.companyId) })) || {};
    return (lu.pptMailTo || []).length ? { ok: true, message: "PPT mails go to " + lu.pptMailTo.join(", ") } : { ok: false, message: "not configured (no PPT recipients set)" };
  }
  return null;
}

async function getAdapters(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return { status: 200, body: { adapters: await adapterStatus(companyId), settings: { pptMailTo: lu.pptMailTo || [] } } };
}

async function patchAdaptersSettings(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const list = (Array.isArray(ctx.body.pptMailTo) ? ctx.body.pptMailTo : String(ctx.body.pptMailTo || "").split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((a) => !EMAIL_RE.test(a));
  if (bad.length) return { status: 400, body: { error: "not an email address: " + bad.join(", ") } };
  const before = ((await repo.lookups.findOne({ companyId })) || {}).pptMailTo || [];
  await repo.lookups.updateOne({ companyId }, { $set: { pptMailTo: [...new Set(list)] } }, { upsert: true });
  await writeAudit(ctx, "AdapterSettingsChanged", { companyId, module: "CRM-01", before: { pptMailTo: before }, after: { pptMailTo: list } });
  return { status: 200, body: { ok: true, pptMailTo: list } };
}

async function postAdaptersByKeyTest(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  let r;
  try {
    r = await runTest(ctx.params.key, ctx);
  } catch (err) {
    r = { ok: false, message: err.message };
  }
  if (!r) return { status: 404, body: { error: "unknown adapter" } };
  if (!/^not configured/.test(r.message || "")) await logRun(ctx.params.key, r.ok, r.message);
  await writeAudit(ctx, "AdapterTested", { companyId: ctx.user.companyId, module: "CRM-01", work: ctx.params.key + ": " + r.message });
  return { status: 200, body: { ok: !!r.ok, message: r.message } };
}

module.exports = { isAdminLayer, adapterStatus, runTest, getAdapters, patchAdaptersSettings, postAdaptersByKeyTest };
