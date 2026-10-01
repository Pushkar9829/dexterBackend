const { oid } = require("../utils/ids");
const repo = require("../utils/shared.repository");

const env = (k) => String(process.env[k] || "").trim();

const isOn = (v) => ["on", "1", "true", "yes"].includes(String(v || "").toLowerCase());

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function logRun(key, ok, result) {
  await repo.adapter_runs.updateOne({ key }, { $set: { key, ok: !!ok, result: String(result || "").slice(0, 300), at: new Date() } }, { upsert: true });
}

async function inboundCompany() {
  const v = env("MAIL_INBOUND_COMPANY");
  if (!v) return null;
  return (oid(v) && (await repo.companies.findById(oid(v)))) || (await repo.companies.findOne({ code: v }));
}

// ---------- SMS / WhatsApp gateways ----------

async function postJson(url, body, token, timeoutMs = 10000) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

module.exports = { env, isOn, EMAIL_RE, logRun, inboundCompany, postJson };
