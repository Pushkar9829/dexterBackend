const tls = require("tls");
const { env, isOn, inboundCompany } = require("./common");
const config = require("../config/env");

// ---------- IMAP inbound (TLS) ----------

function imapConnect(c) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: !c.insecure });
    let buf = Buffer.alloc(0);
    let greeted = false;
    let seq = 0;
    let current = null;
    const fail = (err) => {
      sock.destroy();
      if (current) current.reject(err);
      else reject(err);
    };
    sock.setTimeout(c.timeout, () => fail(new Error("IMAP timeout")));
    sock.on("error", fail);
    const api = {
      cmd(text) {
        return new Promise((reply, rej) => {
          current = { tag: "A" + ++seq, resolve: reply, reject: rej, lines: [], literals: [], need: 0 };
          sock.write(current.tag + " " + text + "\r\n");
        });
      },
      close() {
        sock.end();
      },
    };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (current && current.need) {
          if (buf.length < current.need) return;
          current.literals.push(buf.subarray(0, current.need));
          buf = buf.subarray(current.need);
          current.need = 0;
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.subarray(0, i).toString("latin1");
        buf = buf.subarray(i + 2);
        if (!greeted) {
          greeted = true;
          if (!/^\* (OK|PREAUTH)/i.test(line)) return reject(new Error("IMAP greeting: " + line));
          resolve(api);
          continue;
        }
        if (!current) continue;
        const lit = /\{(\d+)\}$/.exec(line);
        if (lit) {
          current.lines.push(line);
          current.need = Number(lit[1]);
          continue;
        }
        if (line.startsWith(current.tag + " ")) {
          const done = current;
          current = null;
          if (/^OK/i.test(line.slice(done.tag.length + 1))) done.resolve(done);
          else done.reject(new Error("IMAP: " + line.slice(done.tag.length + 1)));
        } else current.lines.push(line);
      }
    });
  });
}

function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    const b = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return b.toString(/utf-?8/i.test(cs) ? "utf8" : "latin1");
  });
}

function splitMessage(raw) {
  const at = raw.indexOf("\r\n\r\n");
  const head = (at < 0 ? raw : raw.slice(0, at)).replace(/\r\n[ \t]+/g, " ");
  const body = at < 0 ? "" : raw.slice(at + 4);
  const headers = {};
  head.split("\r\n").forEach((l) => {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  });
  return { headers, body };
}

function decodeBody(body, encoding) {
  const e = String(encoding || "").toLowerCase();
  if (e === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (e === "quoted-printable") return Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  return body;
}

function plainText(part) {
  const type = part.headers["content-type"] || "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type);
  if (/^multipart\//i.test(type) && boundary) {
    const pieces = part.body.split("--" + boundary[1]).slice(1).filter((p) => !p.startsWith("--"));
    for (const p of pieces) {
      const t = plainText(splitMessage(p.replace(/^\r\n/, "")));
      if (t !== null) return t;
    }
    return null;
  }
  return /^text\/plain/i.test(type) ? decodeBody(part.body, part.headers["content-transfer-encoding"]) : null;
}

function parseRfc822(buf) {
  const msg = splitMessage(buf.toString("latin1"));
  const h = msg.headers;
  const addr = (v) => (decodeWords(v).match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map((a) => a.toLowerCase());
  return {
    from: addr(h.from)[0] || "",
    to: addr(h.to),
    subject: decodeWords(h.subject || ""),
    messageId: (h["message-id"] || "").trim(),
    inReplyTo: (h["in-reply-to"] || "").trim(),
    references: (h.references || "").split(/\s+/).filter(Boolean),
    body: (plainText(msg) || "").slice(0, 20000),
  };
}

const quote = (s) => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';

async function pollImap() {
  if (env("MAIL_INBOUND") !== "imap") return { ok: false, message: "not configured (MAIL_INBOUND is " + (env("MAIL_INBOUND") || "off") + ")" };
  const c = { host: env("IMAP_HOST"), port: Number(env("IMAP_PORT")) || 993, user: env("IMAP_USER"), pass: config.IMAP_PASS || "", insecure: isOn(env("IMAP_TLS_INSECURE")), timeout: 30000 };
  const company = await inboundCompany();
  if (!c.host || !c.user || !company) return { ok: false, message: "not configured (IMAP_HOST, IMAP_USER and MAIL_INBOUND_COMPANY needed)" };
  const { receiveInbound } = require("../modules/mail/mail.service");
  const { SYSTEM_REQ } = require("../modules/mail/mail.model");
  const req = { ...SYSTEM_REQ, user: { login: "imap", companyId: company._id } };
  const imap = await imapConnect(c);
  const out = { fetched: 0, mapped: 0, duplicate: 0, errors: 0 };
  try {
    await imap.cmd("LOGIN " + quote(c.user) + " " + quote(c.pass));
    await imap.cmd("SELECT " + quote(env("IMAP_MAILBOX") || "INBOX"));
    const search = await imap.cmd("UID SEARCH UNSEEN");
    const uids = ((search.lines.find((l) => /^\* SEARCH/i.test(l)) || "").replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean)).slice(0, 25);
    for (const uid of uids) {
      const f = await imap.cmd("UID FETCH " + uid + " (BODY.PEEK[])");
      if (!f.literals[0]) continue;
      out.fetched++;
      const m = parseRfc822(f.literals[0]);
      if (!m.messageId) m.messageId = "<imap-" + uid + "." + Date.now() + "@" + c.host + ">";
      const r = await receiveInbound(req, company._id, m, { via: "imap" });
      if (r.status === 200) out.mapped += r.body.mapped ? 1 : 0;
      else if (r.status === 409) out.duplicate++;
      else out.errors++;
      await imap.cmd("UID STORE " + uid + " +FLAGS (\\Seen)");
    }
    await imap.cmd("LOGOUT").catch(() => null);
  } finally {
    imap.close();
  }
  return { ok: true, message: out.fetched + " fetched, " + out.mapped + " mapped to tickets, " + out.duplicate + " already recorded", ...out };
}

module.exports = { imapConnect, decodeWords, splitMessage, decodeBody, plainText, parseRfc822, quote, pollImap };
