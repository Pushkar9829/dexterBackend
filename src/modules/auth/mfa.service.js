const crypto = require("crypto");
const config = require("../../config/env");
const repo = require("./auth.repository");
const { B32, KEY, ISSUER, RECOVERY_DAYS } = require("./mfa.model");
const { writeAudit } = require("../../utils/audit-writer");
const { FRANCHISE_LAYERS } = require("../../utils/scope");

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const num = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(num % 1000000).padStart(6, "0");
}

function totp(secret, at) {
  return hotp(secret, Math.floor((at || Date.now()) / 30000));
}

function totpStep(secret, code, at) {
  const c = String(code || "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(c)) return null;
  const step = Math.floor((at || Date.now()) / 30000);
  const d = [-1, 0, 1].find((x) => hotp(secret, step + x) === c);
  return d === undefined ? null : step + d;
}

function totpOk(secret, code, at) {
  return totpStep(secret, code, at) !== null;
}

// A login code is good once: the matched time step is recorded, and a code from the same or an earlier step is refused.
async function claimTotp(user, secret, code) {
  const step = totpStep(secret, code);
  if (step === null) return false;
  const r = await repo.users.updateOne({ _id: user._id, totpLastStep: { $not: { $gte: step } } }, { $set: { totpLastStep: step } });
  return r.matchedCount === 1;
}

function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function unseal(text) {
  const [iv, tag, enc] = String(text || "").split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

async function mfaNeeded(user) {
  if (user.mfaRequired === false) return false;
  if (FRANCHISE_LAYERS.includes(user.hierarchy)) {
    const co = await repo.companies.findById(user.companyId);
    if (co && co.mfaRelaxFranchise) return false;
  }
  return true;
}

function userTotp(user) {
  if (!user.totpEnabled || !user.totpSecret) return null;
  try {
    return unseal(user.totpSecret);
  } catch {
    return null;
  }
}

async function deliverCode(user, code, purpose) {
  const channel = config.MFA_CHANNEL || "demo";
  if (channel === "mail" || channel === "sms" || channel === "whatsapp") {
    try {
      const r = await require("../../adapters/messaging").sendCode(channel, user, code, purpose);
      return { channel, ...r };
    } catch (err) {
      return { channel, error: err.message };
    }
  }
  return { channel: channel === "totp" ? "demo" : channel };
}

async function useRecoveryCode(ctx, user, code) {
  const h = hashCode(code);
  const r = await repo.users.findOneAndUpdate(
    { _id: user._id, recoveryCodes: { $elemMatch: { hash: h, usedAt: null, expiresAt: { $gt: new Date() } } } },
    { $set: { "recoveryCodes.$.usedAt": new Date() } },
    { returnDocument: "after" }
  );
  const row = r && r.value !== undefined ? r.value : r;
  if (!row) return false;
  const left = (row.recoveryCodes || []).filter((c) => !c.usedAt && new Date(c.expiresAt) > new Date()).length;
  ctx.user = user;
  await writeAudit(ctx, "RecoveryCodeUsed", { companyId: user.companyId, module: "CRM-01", recordId: user._id, work: left + " codes left" });
  return true;
}

async function getAuthMfaStatus(ctx) {
  const u = ctx.user;
  const codes = (u.recoveryCodes || []).filter((c) => !c.usedAt && new Date(c.expiresAt) > new Date());
  return { status: 200, body: {
    mfaRequired: await mfaNeeded(u),
    totpEnabled: !!u.totpEnabled,
    recoveryLeft: codes.length,
    recoveryExpires: codes.length ? codes[0].expiresAt : null,
    channel: config.MFA_CHANNEL || "demo",
  } };
}

async function postAuthTotpSetup(ctx) {
  if (userTotp(ctx.user)) return { status: 400, body: { error: "an authenticator is already on; turn it off with its current code first" } };
  const secret = crypto.randomBytes(20);
  const key = base32Encode(secret);
  await repo.users.updateById(ctx.user._id, { $set: { totpPending: seal(secret) } });
  const label = encodeURIComponent(ISSUER + ":" + ctx.user.login);
  const uri = "otpauth://totp/" + label + "?secret=" + key + "&issuer=" + encodeURIComponent(ISSUER) + "&algorithm=SHA1&digits=6&period=30";
  return { status: 200, body: { key, uri } };
}

async function postAuthTotpEnable(ctx) {
  const fresh = await repo.users.findById(ctx.user._id);
  if (!fresh.totpPending) return { status: 400, body: { error: "start setup first" } };
  if (userTotp(fresh)) return { status: 400, body: { error: "an authenticator is already on; turn it off with its current code first" } };
  const secret = unseal(fresh.totpPending);
  if (!totpOk(secret, ctx.body.code)) return { status: 400, body: { error: "code does not match; check the phone clock" } };
  await repo.users.updateById(fresh._id, { $set: { totpSecret: fresh.totpPending, totpEnabled: true }, $unset: { totpPending: "" } });
  await writeAudit(ctx, "MfaEnrolled", { companyId: fresh.companyId, module: "CRM-01", recordId: fresh._id, work: "authenticator app" });
  return { status: 200, body: { ok: true } };
}

async function postAuthTotpDisable(ctx) {
  const secret = userTotp(ctx.user);
  if (!secret) return { status: 200, body: { ok: true } };
  if (!totpOk(secret, ctx.body.code)) return { status: 400, body: { error: "invalid code" } };
  await repo.users.updateById(ctx.user._id, { $set: { totpEnabled: false }, $unset: { totpSecret: "" } });
  await writeAudit(ctx, "MfaRemoved", { companyId: ctx.user.companyId, module: "CRM-01", recordId: ctx.user._id, work: "authenticator app" });
  return { status: 200, body: { ok: true } };
}

async function postAuthRecoveryCodes(ctx) {
  const secret = userTotp(ctx.user);
  if (secret && !totpOk(secret, (ctx.body || {}).code)) return { status: 400, body: { error: "enter the current code from your authenticator app" } };
  const expiresAt = new Date(Date.now() + RECOVERY_DAYS * 86400000);
  const plain = Array.from({ length: 8 }, () => {
    const s = base32Encode(crypto.randomBytes(5));
    return s.slice(0, 4) + "-" + s.slice(4, 8);
  });
  await repo.users.updateById(ctx.user._id, { $set: { recoveryCodes: plain.map((c) => ({ hash: hashCode(c), expiresAt, usedAt: null })) } });
  await writeAudit(ctx, "RecoveryCodesIssued", { companyId: ctx.user.companyId, module: "CRM-01", recordId: ctx.user._id, work: plain.length + " codes, expire " + expiresAt.toISOString().slice(0, 10) });
  return { status: 200, body: { codes: plain, expiresAt } };
}

module.exports = { base32Encode, base32Decode, hotp, totp, totpOk, totpStep, claimTotp, seal, unseal, hashCode, mfaNeeded, userTotp, deliverCode, useRecoveryCode, getAuthMfaStatus, postAuthTotpSetup, postAuthTotpEnable, postAuthTotpDisable, postAuthRecoveryCodes };
