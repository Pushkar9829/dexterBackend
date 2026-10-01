const { env, postJson } = require("./common");
const { readFileData } = require("../utils/files");

const ID_DOC_RE = /\b(pan|aadhaar|aadhar|driving|dl|licen[cs]e)\b/i;

// ---------- PAN / Aadhaar / DL identity check ----------

async function identityCheck(doc) {
  const url = env("IDCHECK_URL");
  const provider = env("IDCHECK_PROVIDER") || (url ? new URL(url).host : "off");
  if (!url) return { provider: "off", status: "Not configured", ref: "", checkedAt: new Date(), error: "IDCHECK_URL not set" };
  try {
    const data = await readFileData(doc);
    const r = await postJson(url, { kind: doc.type, documentId: String(doc._id), fileName: doc.fileName, mime: doc.mime, data: data.toString("base64") }, env("IDCHECK_TOKEN"), Number(env("IDCHECK_TIMEOUT_MS")) || 15000);
    return { provider, status: String(r.status || "Unknown"), ref: String(r.ref || r.id || ""), checkedAt: new Date(), error: "" };
  } catch (err) {
    return { provider, status: "Failed", ref: "", checkedAt: new Date(), error: err.message.slice(0, 300) };
  }
}

module.exports = { ID_DOC_RE, identityCheck };
