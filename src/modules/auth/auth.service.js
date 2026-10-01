const { ObjectId } = require("mongodb");
const config = require("../../config/env");
const { LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILS, DEMO_OTP, MFA_MAX_ATTEMPTS } = config;
const { isReadOnly, isOfficeAdmin, isOfficeStaff, isDeskStaff, isFieldStaff, canSetLinkShared, canApproveApplication, canCreateAtm } = require("../../middlewares/rbac");
const { startSessionLog, endSessionLog, canViewAudit } = require("../audit/audit.service");
const repo = require("./auth.repository");
const { BLOCKED_FRANCHISE } = require("./auth.model");
const { mfaNeeded, userTotp, deliverCode, useRecoveryCode, claimTotp } = require("./mfa.service");
const { CREATABLE_LAYERS } = require("../users/users.model");
const { effectiveActions } = require("../users/users.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { checkPassword, randomOtp, passwordProblem, hashPassword } = require("../../utils/password");
const { signToken } = require("../../utils/token");

function publicUser(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    login: u.login,
    name: u.name,
    hierarchy: u.hierarchy,
    functionalRole: u.functionalRole || "",
    companyId: u.companyId ? String(u.companyId) : null,
    homeCompanyId: String(u.homeCompanyId || u.companyId || ""),
    canSwitchCompany: u.hierarchy === "DexterIndiaCompanyTeam",
    franchiseId: u.franchiseId ? String(u.franchiseId) : null,
    projectIds: (u.projectIds || []).map(String),
    scopeRegion: u.scopeRegion || "",
    team: u.team || "",
    recordScope: u.recordScope || "all",
    scopeAtmIds: u.scopeAtmIds || [],
    scopeSiteIds: u.scopeSiteIds || [],
    scopeTicketCategories: u.scopeTicketCategories || [],
    scopeDockets: u.scopeDockets || [],
    roleTemplate: u.roleTemplate || "",
    readOnly: isReadOnly(u),
    mfaRequired: u.mfaRequired !== false,
    totpEnabled: !!u.totpEnabled,
    officeAdmin: isOfficeAdmin(u),
    officeStaff: isOfficeStaff(u),
    deskStaff: isDeskStaff(u),
    canDecide: canApproveApplication(u),
    canCreateAtm: canCreateAtm(u),
    canViewAudit: canViewAudit(u),
    fieldStaff: isFieldStaff(u),
    canSetLinkShared: canSetLinkShared(u),
    actions: effectiveActions(u),
    modules: u.modules || [],
    creatableLayers: CREATABLE_LAYERS[u.hierarchy] || [],
  };
}

// An empty login must never match: users created without a mobile number store mobile "".
function loginFilter(login) {
  return login ? { $or: [{ login }, { mobile: login }] } : null;
}

const LOCK_MESSAGE = "too many failed logins; try again after " + LOGIN_LOCK_MINUTES + " minutes or reset your password";

// Unknown and inactive logins lock out like real ones, so a 429 does not reveal that an account exists.
const ghostFails = new Map();
function ghostFail(login) {
  const now = Date.now();
  let row = ghostFails.get(login);
  if (row && row.lockedUntil && row.lockedUntil <= now) row = null;
  if (!row) row = { count: 0, lockedUntil: 0 };
  if (row.lockedUntil > now) return true;
  row.count += 1;
  if (row.count >= LOGIN_MAX_FAILS) row.lockedUntil = now + LOGIN_LOCK_MINUTES * 60000;
  ghostFails.set(login, row);
  if (ghostFails.size > 10000) ghostFails.delete(ghostFails.keys().next().value);
  return false;
}

// Counts one attempt on a ticket before the code is checked, so parallel guesses cannot exceed the limit.
async function claimAttempt(ticketId) {
  const r = await repo.mfa_tickets.findOneAndUpdate({ _id: ticketId, attempts: { $not: { $gte: MFA_MAX_ATTEMPTS } } }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
  const row = r && r.value !== undefined ? r.value : r;
  if (row && row.attempts >= MFA_MAX_ATTEMPTS) await repo.mfa_tickets.deleteOne({ _id: ticketId, attempts: { $gte: MFA_MAX_ATTEMPTS } });
  return !!row;
}

async function postAuthLogin(ctx) {
  const login = String(ctx.body.login || "").trim().toLowerCase();
  const password = String(ctx.body.password || "");
  const filter = loginFilter(login);
  if (!filter || !password) return { status: 400, body: { error: "login and password required" } };
  const user = await repo.users.findOne(filter);
  if (!user || !user.active) {
    const locked = ghostFail(login);
    await writeAudit(ctx, "LoginFailure", { login, work: "unknown or inactive" });
    if (locked) return { status: 429, body: { error: LOCK_MESSAGE } };
    return { status: 401, body: { error: "invalid login" } };
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    ctx.user = user;
    await writeAudit(ctx, "LoginFailure", { login, companyId: user.companyId, work: "locked" });
    return { status: 429, body: { error: LOCK_MESSAGE } };
  }
  let ok = false;
  try {
    ok = checkPassword(password, user.passwordSalt, user.passwordHash);
  } catch {
    ok = false;
  }
  if (!ok) {
    ctx.user = user;
    const r = await repo.users.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { returnDocument: "after" });
    const after = r && r.value !== undefined ? r.value : r;
    const fails = (after && after.failedLogins) || 1;
    const lock = fails >= LOGIN_MAX_FAILS;
    if (lock) await repo.users.updateById(user._id, { $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000) } });
    await writeAudit(ctx, lock ? "LoginLocked" : "LoginFailure", { login, companyId: user.companyId, work: lock ? "locked for " + LOGIN_LOCK_MINUTES + " min after " + fails + " bad passwords" : "bad password" });
    return { status: 401, body: { error: "invalid login" } };
  }
  if (user.failedLogins || user.lockedUntil) await repo.users.updateById(user._id, { $set: { failedLogins: 0, lockedUntil: null } });
  const co = await repo.companies.findById(user.companyId);
  if (co && co.active === false) {
    ctx.user = user;
    await writeAudit(ctx, "LoginFailure", { login, companyId: user.companyId, work: "company inactive" });
    return { status: 401, body: { error: "company is inactive" } };
  }
  const emp = await repo.employees.findOne({ userId: user._id, employmentStatus: { $ne: "Active" } });
  if (emp) {
    ctx.user = user;
    await writeAudit(ctx, "LoginFailure", { login, companyId: user.companyId, work: "employee " + emp.employmentStatus });
    return { status: 401, body: { error: "employee record is " + emp.employmentStatus + "; ask Admin" } };
  }
  const node = user.franchiseId ? await repo.franchises.findOne({ _id: user.franchiseId, status: { $in: BLOCKED_FRANCHISE } }, { projection: { status: 1 } }) : null;
  if (node) {
    ctx.user = user;
    await writeAudit(ctx, "LoginFailure", { login, companyId: user.companyId, work: "franchise " + node.status });
    return { status: 401, body: { error: "your franchise is " + node.status.toLowerCase() + "; contact the Dexter office" } };
  }
  ctx.user = user;
  if (!(await mfaNeeded(user))) {
    await writeAudit(ctx, "LoginPasswordOk", { login, companyId: user.companyId, work: "MFA not required for this user" });
    return issueSession(ctx, user, "password only (MFA relaxed)");
  }
  const secret = userTotp(user);
  const otp = secret ? null : randomOtp();
  const ticketId = new ObjectId();
  await repo.mfa_tickets.insert({
    _id: ticketId,
    userId: user._id,
    otp,
    method: secret ? "totp" : "code",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ip: ctx.ip,
  });
  const sent = otp ? await deliverCode(user, otp, "login") : {};
  await writeAudit(ctx, "LoginPasswordOk", { login, companyId: user.companyId, work: "MFA ticket issued (" + (secret ? "authenticator" : sent.channel || "demo") + ")" });
  return { status: 200, body: {
    mfaRequired: true,
    ticket: String(ticketId),
    method: secret ? "totp" : "code",
    ...(DEMO_OTP && otp && sent.channel === "demo" ? { otpDemo: otp } : {}),
    message: secret ? "Enter the 6-digit code from your authenticator app, or a recovery code." : DEMO_OTP && sent.channel === "demo" ? "No mail gateway in this stack. Enter otpDemo as the second factor." : "Enter the code sent to you, or a recovery code.",
  } };
}

async function issueSession(ctx, user, work) {
  const sessionId = new ObjectId();
  await repo.sessions.insert({
    _id: sessionId,
    userId: user._id,
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    lastSeenAt: new Date(),
    ip: ctx.ip,
  });
  await startSessionLog(ctx, user, sessionId);
  ctx.user = user;
  await writeAudit(ctx, "LoginSuccess", { companyId: user.companyId, work });
  return { status: 200, body: { token: signToken(String(sessionId)), user: publicUser(user) } };
}

async function postAuthMfa(ctx) {
  const ticket = oid(ctx.body.ticket);
  const otp = String(ctx.body.otp || "").trim();
  const recovery = String(ctx.body.recoveryCode || "").trim();
  if (!ticket) return { status: 400, body: { error: "ticket required" } };
  let row = await repo.mfa_tickets.findOne({ _id: ticket, reset: { $ne: true }, expiresAt: { $gt: new Date() } });
  if (row && !(await claimAttempt(row._id))) row = null;
  let good = false;
  if (row) {
    const owner = await repo.users.findOne({ _id: row.userId, active: true });
    if (owner && recovery) good = await useRecoveryCode(ctx, owner, recovery);
    else if (owner && row.method === "totp") good = await claimTotp(owner, userTotp(owner), otp);
    else good = !!row.otp && row.otp === otp;
  }
  if (!good) {
    const who = row ? await repo.users.findById(row.userId) : null;
    if (who) ctx.user = who;
    await writeAudit(ctx, "LoginFailure", { companyId: who && who.companyId, work: "bad MFA" });
    ctx.user = null;
    return { status: 401, body: { error: "invalid code" } };
  }
  const user = await repo.users.findOne({ _id: row.userId, active: true });
  await repo.mfa_tickets.deleteById(ticket);
  if (!user) return { status: 401, body: { error: "invalid login" } };
  return await issueSession(ctx, user, recovery ? "MFA ok (recovery code)" : "MFA ok");
}

async function getAuthMe(ctx) {
  return { status: 200, body: { user: publicUser(ctx.user) } };
}

async function postAuthLogout(ctx) {
  if (ctx.sessionId) {
    await repo.sessions.deleteById(ctx.sessionId);
    await endSessionLog({ _id: ctx.sessionId }, "Logout");
  }
  await writeAudit(ctx, "Logout", { companyId: ctx.user.companyId });
  return { status: 200, body: { ok: true } };
}

async function postAuthForgot(ctx) {
  const login = String(ctx.body.login || "").trim().toLowerCase();
  const filter = loginFilter(login);
  const user = filter ? await repo.users.findOne({ ...filter, active: true }) : null;
  const message = "If the login exists, a reset code was sent";
  if (!user) {
    const demo = DEMO_OTP && ["demo", "totp"].includes(config.MFA_CHANNEL || "demo");
    return { status: 200, body: { ok: true, message, ticket: String(new ObjectId()), ...(demo ? { otpDemo: randomOtp() } : {}) } };
  }
  const otp = randomOtp();
  const ticketId = new ObjectId();
  await repo.mfa_tickets.deleteMany({ userId: user._id, reset: true });
  await repo.mfa_tickets.insert({
    _id: ticketId,
    userId: user._id,
    otp,
    reset: true,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ip: ctx.ip,
  });
  const sent = await deliverCode(user, otp, "reset");
  await writeAudit(ctx, "PasswordReset", { login: user.login, companyId: user.companyId, work: "reset ticket (" + (sent.channel || "demo") + ")" });
  return { status: 200, body: { ok: true, message, ticket: String(ticketId), ...(DEMO_OTP && sent.channel === "demo" ? { otpDemo: otp } : {}) } };
}

async function postAuthReset(ctx) {
  const ticket = oid(ctx.body.ticket);
  const otp = String(ctx.body.otp || "").trim();
  const password = String(ctx.body.password || "");
  if (!ticket || !password) return { status: 400, body: { error: "ticket and password required" } };
  const row = await repo.mfa_tickets.findOne({ _id: ticket, reset: true, expiresAt: { $gt: new Date() } });
  if (!row || !(await claimAttempt(row._id)) || row.otp !== otp) return { status: 401, body: { error: "invalid code" } };
  const weak = passwordProblem(password);
  if (weak) return { status: 400, body: { error: weak } };
  const pass = hashPassword(password);
  await repo.users.updateById(row.userId, { $set: { passwordSalt: pass.salt, passwordHash: pass.hash, failedLogins: 0, lockedUntil: null } });
  await repo.mfa_tickets.deleteMany({ userId: row.userId });
  await repo.sessions.deleteMany({ userId: row.userId });
  await endSessionLog({ userId: row.userId }, "Password reset");
  const owner = await repo.users.findById(row.userId);
  await writeAudit(ctx, "PasswordReset", { login: owner && owner.login, companyId: owner && owner.companyId, work: "password set", recordId: row.userId });
  return { status: 200, body: { ok: true } };
}

module.exports = { publicUser, issueSession, postAuthLogin, postAuthMfa, getAuthMe, postAuthLogout, postAuthForgot, postAuthReset };
