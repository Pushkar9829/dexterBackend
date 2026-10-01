const { env, postJson, EMAIL_RE } = require("./common");
const { sendMailNow } = require("./smtp");

async function sendSms(mobile, text) {
  if (!env("SMS_GATEWAY_URL")) return { ok: false, error: "SMS gateway not configured" };
  if (!mobile) return { ok: false, error: "no mobile number" };
  const r = await postJson(env("SMS_GATEWAY_URL"), { to: String(mobile), text: String(text).slice(0, 480), sender: env("SMS_SENDER_ID") || undefined }, env("SMS_GATEWAY_TOKEN"));
  return { ok: true, ref: r.id || r.messageId || r.ref || "" };
}

async function sendChat(mobile, text) {
  if (!env("CHAT_GATEWAY_URL")) return { ok: false, error: "WhatsApp gateway not configured" };
  if (!mobile) return { ok: false, error: "no mobile number" };
  const r = await postJson(env("CHAT_GATEWAY_URL"), { to: String(mobile), text: String(text).slice(0, 1000), template: env("CHAT_TEMPLATE") || undefined }, env("CHAT_GATEWAY_TOKEN"));
  return { ok: true, ref: r.id || r.messageId || r.ref || "" };
}

async function sendCode(channel, user, code, purpose) {
  const text = "Your Dexter CRM " + (purpose === "reset" ? "password reset" : "sign-in") + " code is " + code + ". It is valid for 5 minutes. Do not share it.";
  if (channel === "mail") {
    const to = [user.email, user.login].find((x) => EMAIL_RE.test(String(x || "")));
    if (!to) return { ok: false, error: "user has no email address" };
    if (require("../modules/mail/mail.model").TRANSPORT !== "smtp") return { ok: false, error: "MAIL_TRANSPORT is not smtp" };
    await sendMailNow(to, "Your Dexter CRM code", text);
    return { ok: true };
  }
  if (channel === "whatsapp") return sendChat(user.mobile, text);
  return sendSms(user.mobile, text);
}

module.exports = { sendSms, sendChat, sendCode };
