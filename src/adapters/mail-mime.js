const crypto = require("crypto");

function headerWord(s) {
  s = String(s || "").replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function b64Lines(buf) {
  return buf.toString("base64").replace(/.{1,76}/g, "$&\r\n");
}

function buildMime(mail, messageId, files) {
  const head = [
    "From: " + mail.from,
    "To: " + mail.to.join(", "),
    ...(mail.cc && mail.cc.length ? ["Cc: " + mail.cc.join(", ")] : []),
    "Subject: " + headerWord(mail.subject),
    "Date: " + new Date().toUTCString().replace("GMT", "+0000"),
    "Message-ID: " + messageId,
    ...(mail.inReplyTo ? ["In-Reply-To: " + mail.inReplyTo] : []),
    ...(mail.references && mail.references.length ? ["References: " + mail.references.join(" ")] : []),
    "MIME-Version: 1.0",
  ];
  const text = b64Lines(Buffer.from(String(mail.body || ""), "utf8"));
  if (!files.length) return [...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", text].join("\r\n");
  const boundary = "af-" + crypto.randomBytes(12).toString("hex");
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${text}`];
  files.forEach((f) => {
    const name = String(f.name).replace(/["\r\n]/g, "_");
    parts.push(`--${boundary}\r\nContent-Type: ${f.mime}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(f.data)}`);
  });
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", parts.join("\r\n") + `\r\n--${boundary}--\r\n`].join("\r\n");
}

module.exports = { headerWord, b64Lines, buildMime };
