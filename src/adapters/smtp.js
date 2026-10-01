const tls = require("tls");
const net = require("net");
const crypto = require("crypto");
const { env, isOn } = require("./common");
const config = require("../config/env");

function mailDomain(from) {
  return (String(from || "").split("@")[1] || "advocateflow.local").replace(/[>\s]/g, "");
}

// ---------- SMTP (net / tls, STARTTLS, AUTH PLAIN with a relay account) ----------

function smtpConfig() {
  const port = Number(env("SMTP_PORT")) || 587;
  return { host: env("SMTP_HOST"), port, secure: isOn(env("SMTP_SECURE")) || port === 465, user: env("SMTP_USER"), pass: config.SMTP_PASS || "", helo: env("SMTP_HELO") || "advocateflow.local", insecure: isOn(env("SMTP_TLS_INSECURE")), timeout: Number(env("SMTP_TIMEOUT_MS")) || 20000 };
}

function lineReader(onReply) {
  let buf = "";
  let lines = [];
  return (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        onReply({ code: Number(line.slice(0, 3)), text: lines.join("\n") });
        lines = [];
      }
    }
  };
}

function smtpSend({ from, rcpt, data }) {
  const c = smtpConfig();
  if (!c.host) return Promise.reject(new Error("SMTP_HOST not set"));
  return new Promise((resolve, reject) => {
    let sock;
    let finished = false;
    const replies = [];
    let waiting = null;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      if (sock) sock.destroy();
      reject(err);
    };
    const onReply = (r) => {
      replies.push(r);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(replies.shift());
      }
    };
    const read = () => new Promise((r) => (replies.length ? r(replies.shift()) : (waiting = r)));
    const attach = (s) => {
      s.on("data", lineReader(onReply));
      s.on("error", fail);
      s.setTimeout(c.timeout, () => fail(new Error("SMTP timeout")));
    };
    const step = async (line, want) => {
      if (line !== null) sock.write(line + "\r\n");
      const r = await read();
      if (String(r.code)[0] !== String(want)) throw new Error(r.code + " " + r.text.split("\n").pop().slice(4));
      return r;
    };
    const run = async () => {
      await step(null, 2);
      let ehlo = await step("EHLO " + c.helo, 2);
      if (!c.secure) {
        if (!/STARTTLS/i.test(ehlo.text)) {
          if (!isOn(env("SMTP_ALLOW_PLAIN"))) throw new Error("server does not offer STARTTLS");
        } else {
          await step("STARTTLS", 2);
          sock.removeAllListeners("data");
          sock.removeAllListeners("error");
          sock.setTimeout(0);
          sock = await new Promise((ok, bad) => {
            const t = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: !c.insecure }, () => ok(t));
            t.once("error", bad);
          });
          attach(sock);
          ehlo = await step("EHLO " + c.helo, 2);
        }
      }
      if (c.user) await step("AUTH PLAIN " + Buffer.from("\0" + c.user + "\0" + c.pass, "utf8").toString("base64"), 2);
      await step("MAIL FROM:<" + from.replace(/^.*<|>.*$/g, "") + ">", 2);
      for (const to of rcpt) await step("RCPT TO:<" + to + ">", 2);
      await step("DATA", 3);
      await step(data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..") + "\r\n.", 2);
      sock.write("QUIT\r\n");
      finished = true;
      sock.end();
      resolve({ ok: true });
    };
    sock = c.secure ? tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: !c.insecure }) : net.connect({ host: c.host, port: c.port });
    attach(sock);
    run().catch(fail);
  });
}

async function sendMailNow(to, subject, body) {
  const { buildMime } = require("./mail-mime");
  const from = env("MAIL_FROM") || env("SMTP_USER");
  const messageId = "<" + crypto.randomBytes(8).toString("hex") + "." + Date.now() + "@" + mailDomain(from) + ">";
  await smtpSend({ from, rcpt: [to], data: buildMime({ from, to: [to], cc: [], subject, body }, messageId, []) });
  return { ok: true, messageId };
}

module.exports = { mailDomain, smtpConfig, lineReader, smtpSend, sendMailNow };
