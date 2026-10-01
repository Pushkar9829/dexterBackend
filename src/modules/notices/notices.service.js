const { KINDS, CHANNELS, EMAIL_RE, COMPLAINT_DONE } = require("./notices.model");
const repo = require("./notices.repository");
const { canRunOps } = require("../ops/ops.service");
const { writeAudit } = require("../../utils/audit-writer");
const { istToday, shiftDate } = require("../../utils/dates");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS } = require("../../utils/scope");

const isAdminLayer = (u) => u.hierarchy === "Admin" || u.hierarchy === "DexterIndiaCompanyTeam";

async function noticeSettings(companyId) {
  const lu = (await repo.lookups.findOne({ companyId: oid(companyId) })) || {};
  const saved = lu.noticeSettings || {};
  return Object.fromEntries(KINDS.map((k) => [k, { on: saved[k] ? saved[k].on !== false : true, channels: saved[k] && Array.isArray(saved[k].channels) ? saved[k].channels.filter((c) => CHANNELS.includes(c)) : ["in-app"] }]));
}

async function sendOutside(companyId, u, n, channels) {
  if (channels.includes("mail")) {
    const to = [u.email, u.login].find((x) => EMAIL_RE.test(String(x || "")));
    if (to) await require("../mail/mail.service").queueAutoMail(companyId, { templateKey: "notice", vars: { title: n.title, body: n.body || "" }, to: [to] }).catch(() => null);
  }
  if (channels.includes("sms") && u.mobile) {
    await require("../../adapters/messaging").sendSms(u.mobile, n.title + (n.body ? ": " + n.body : "")).catch(() => null);
  }
  if (channels.includes("whatsapp") && u.mobile) {
    await require("../../adapters/messaging").sendChat(u.mobile, n.title + (n.body ? ": " + n.body : "")).catch(() => null);
  }
}

async function notify(companyId, userIds, n) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))].map(oid).filter(Boolean);
  if (!ids.length) return 0;
  const setting = (await noticeSettings(companyId))[n.kind] || { on: true, channels: ["in-app"] };
  if (!setting.on) return 0;
  const channels = setting.channels.length ? setting.channels : ["in-app"];
  const users = await repo.users.list({ _id: { $in: ids }, active: true }, { projection: { _id: 1, login: 1, email: 1, mobile: 1 } });
  let sent = 0;
  for (const u of users) {
    const doc = { companyId, userId: u._id, kind: n.kind, title: n.title, body: n.body || "", link: n.link || null, key: n.key || null, channels, read: false, createdAt: new Date() };
    let fresh = false;
    if (n.key) {
      const r = await repo.notices.updateOne({ companyId, userId: u._id, key: n.key }, { $setOnInsert: doc }, { upsert: true });
      fresh = !!r.upsertedCount;
    } else {
      await repo.notices.insert(doc);
      fresh = true;
    }
    if (fresh) {
      sent++;
      if (channels.some((c) => c !== "in-app")) await sendOutside(companyId, u, n, channels);
    }
  }
  return sent;
}

async function officeDesk(companyId) {
  const list = await repo.users.list({ companyId, active: true, hierarchy: { $in: ["Admin", "SubAdmin"] }, functionalRole: { $nin: ["SalesOfficer", "Inspector", "Finance"] } }, { projection: { _id: 1 } });
  return list.map((u) => u._id);
}

async function companyAdmins(companyId) {
  return (await repo.users.list({ companyId, active: true, hierarchy: "Admin" }, { projection: { _id: 1 } })).map((u) => u._id);
}

async function franchiseUsers(companyId, franchiseId) {
  if (!franchiseId) return [];
  const node = await repo.franchises.findOne({ _id: oid(franchiseId), companyId });
  const nodes = [franchiseId, node && node.masterId, node && node.superMasterId].filter(Boolean).map(oid);
  const list = await repo.users.list({ companyId, active: true, hierarchy: { $in: FRANCHISE_LAYERS }, franchiseId: { $in: nodes } }, { projection: { _id: 1 } });
  return list.map((u) => u._id);
}

async function notifyFranchise(companyId, franchiseId, n) {
  return notify(companyId, await franchiseUsers(companyId, franchiseId), n);
}

async function sweepNotices(companyId, now) {
  const out = { slaWarning: 0, slaBreach: 0, affidavit: 0, eod: 0 };
  const desk = await officeDesk(companyId);

  const open = await repo.complaints.list({ companyId, status: { $nin: COMPLAINT_DONE }, dueAt: { $ne: null, $lte: new Date(now.getTime() + 3600 * 1000) } }, { projection: { docketNumber: 1, atmId: 1, dueAt: 1, ownerUserId: 1, visitOfficerIds: 1, createdAt: 1 } });
  for (const c of open) {
    const link = { page: "service", id: String(c._id) };
    if (new Date(c.dueAt) <= now) {
      out.slaBreach += await notify(companyId, [...desk, c.ownerUserId], { kind: "sla-breach", title: "SLA breached: " + c.docketNumber, body: "ATM " + c.atmId + " was due " + new Date(c.dueAt).toISOString(), link, key: "sla-breach:" + c._id });
    } else {
      out.slaWarning += await notify(companyId, [c.ownerUserId || desk[0]], { kind: "sla-warning", title: "SLA due within 1 hour: " + c.docketNumber, body: "ATM " + c.atmId, link, key: "sla-warn:" + c._id });
    }
  }

  const reminders = await repo.complaints.list({ companyId, status: { $nin: COMPLAINT_DONE }, reminderAt: { $ne: null, $lte: now } }, { projection: { docketNumber: 1, atmId: 1, reminderAt: 1, ownerUserId: 1 } });
  for (const c of reminders) {
    out.reminder = (out.reminder || 0) + (await notify(companyId, c.ownerUserId ? [c.ownerUserId] : desk, {
      kind: "reminder",
      title: "Ticket reminder: " + c.docketNumber,
      body: "ATM " + c.atmId,
      link: { page: "service", id: String(c._id) },
      key: "ticket-remind:" + c._id + ":" + new Date(c.reminderAt).getTime(),
    }));
  }

  const today = istToday();
  const apps = await repo.applications.list({ companyId, status: { $in: ["Submitted", "Approved"] } }, { projection: { siteLocationName: 1, createdBy: 1, franchiseId: 1 } });
  if (apps.length) {
    const done = new Set((await repo.documents.distinct("parentId", { companyId, type: "Affidavit", parentId: { $in: apps.map((a) => a._id) } })).map(String));
    for (const a of apps.filter((x) => !done.has(String(x._id)))) {
      out.affidavit += await notify(companyId, [a.createdBy, ...(await franchiseUsers(companyId, a.franchiseId))], { kind: "affidavit", title: "Affidavit pending", body: a.siteLocationName || "", link: { page: "affidavit", id: String(a._id) }, key: "affidavit:" + a._id + ":" + today });
    }
  }

  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const renewDays = Number(lu.agreementRenewalDays) > 0 ? Number(lu.agreementRenewalDays) : 60;
  const termed = await repo.agreements.list({ companyId, status: "Approved", endDate: { $nin: [null, ""] } }, { projection: { endDate: 1, renewalDate: 1, applicationId: 1, franchiseId: 1, createdBy: 1 } });
  const expiring = termed.filter((g) => (g.renewalDate || shiftDate(g.endDate, -renewDays)) <= today);
  if (expiring.length) {
    const admins = await companyAdmins(companyId);
    const names = new Map((await repo.applications.list({ _id: { $in: expiring.map((g) => g.applicationId).filter(Boolean) } }, { projection: { siteLocationName: 1 } })).map((a) => [String(a._id), a.siteLocationName]));
    for (const g of expiring) {
      const expired = g.endDate < today;
      const site = names.get(String(g.applicationId)) || "site";
      out.renewal = (out.renewal || 0) + (await notify(companyId, [...admins, g.createdBy, ...(await franchiseUsers(companyId, g.franchiseId))], {
        kind: "legal",
        title: (expired ? "Agreement expired: " : "Agreement renewal due: ") + site,
        body: (expired ? "Ended on " : "Ends on ") + g.endDate,
        link: { page: "legal", id: String(g._id) },
        key: "agreement-" + (expired ? "expired:" : "renew:") + g._id + ":" + g.endDate,
      }));
    }
  }

  const every = Number(lu.stageReminderDays) > 0 ? Number(lu.stageReminderDays) : 3;
  const projects = await repo.site_projects.list({ companyId, completedAt: null, held: { $ne: true } }, { projection: { stages: 1, updatedAt: 1, createdBy: 1, siteLocationName: 1, siteNumber: 1 } });
  for (const p of projects) {
    const idx = (p.stages || []).findIndex((s) => !s.approvedAt);
    if (idx < 0) continue;
    const days = Math.floor((now - new Date(p.updatedAt)) / 86400000);
    if (days < every) continue;
    out.stage = (out.stage || 0) + (await notify(companyId, [p.createdBy, ...desk], {
      kind: "stage",
      title: "Stage pending " + days + " days: " + p.stages[idx].name,
      body: (p.siteLocationName || p.siteNumber || "Project") + " has not moved since " + new Date(p.updatedAt).toISOString().slice(0, 10),
      link: { page: "projects", id: String(p._id) },
      key: "stage-remind:" + p._id + ":" + idx + ":" + Math.floor(days / every),
    }));
  }

  const day = shiftDate(today, -1);
  const live = (await repo.atms.list({ companyId, cashLiveDate: { $ne: null } }, { projection: { atmId: 1, cashLiveDate: 1 } })).filter((a) => new Date(a.cashLiveDate).toISOString().slice(0, 10) <= day);
  if (live.length) {
    const submitted = new Set(await repo.ops_eod.distinct("atmId", { companyId, date: day, status: { $in: ["Submitted", "Verified"] } }));
    const missing = live.map((a) => a.atmId).filter((id) => !submitted.has(id));
    if (missing.length) {
      const ops = (await repo.users.list({ companyId, active: true })).filter(canRunOps).map((u) => u._id);
      out.eod += await notify(companyId, ops, {
        kind: "eod",
        title: "EOD not submitted for " + day + " (" + missing.length + " ATM" + (missing.length > 1 ? "s" : "") + ")",
        body: missing.slice(0, 20).join(", ") + (missing.length > 20 ? " …" : ""),
        link: { page: "ops", type: "Day board", date: day },
        key: "eod-unsubmitted:" + day,
      });
    }
  }

  // from the 5th, remind each franchise that has no statement for last month (one notice per franchise per month)
  if (Number(today.slice(8, 10)) >= 5) {
    const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const have = new Set((await repo.bank_statements.distinct("franchiseId", { companyId, month: lastMonth })).map(String));
    const nodes = await repo.franchises.list({ companyId, layer: "Franchise", active: { $ne: false } }, { projection: { name: 1 } });
    for (const n of nodes.filter((x) => !have.has(String(x._id)))) {
      out.bankStatement = (out.bankStatement || 0) + (await notify(companyId, await franchiseUsers(companyId, n._id), {
        kind: "finance",
        title: "Upload bank statement for " + lastMonth,
        body: n.name,
        link: { page: "finance", type: "Bank statements", month: lastMonth },
        key: "bs-missing:" + n._id + ":" + lastMonth,
      }));
    }
  }
  return out;
}

async function getNotices(ctx) {
  const mine = { userId: ctx.user._id, companyId: oid(ctx.user.companyId) };
  const filter = { ...mine };
  if (ctx.query.unread) filter.read = false;
  if (KINDS.includes(ctx.query.kind)) filter.kind = ctx.query.kind;
  const [rows, unread] = await Promise.all([repo.notices.list(filter, { sort: { createdAt: -1 }, limit: 200 }), repo.notices.count({ ...mine, read: false })]);
  return { status: 200, body: { rows, unread } };
}

async function getNoticesSettings(ctx) {
  return { status: 200, body: { kinds: KINDS, channels: CHANNELS, settings: await noticeSettings(ctx.user.companyId), canEdit: isAdminLayer(ctx.user) } };
}

async function patchNoticesSettings(ctx) {
  if (!isAdminLayer(ctx.user)) return { status: 403, body: { error: "Admin sets notice rules" } };
  const companyId = oid(ctx.user.companyId);
  const before = await noticeSettings(companyId);
  const next = { ...before };
  for (const [kind, v] of Object.entries(ctx.body.settings || {})) {
    if (!KINDS.includes(kind)) return { status: 400, body: { error: "unknown notice kind " + kind } };
    const channels = Array.isArray(v.channels) ? v.channels : before[kind].channels;
    if (channels.some((c) => !CHANNELS.includes(c))) return { status: 400, body: { error: "channels must be from " + CHANNELS.join(", ") } };
    next[kind] = { on: v.on === undefined ? before[kind].on : !!v.on, channels: [...new Set(channels)] };
  }
  await repo.lookups.updateOne({ companyId }, { $set: { noticeSettings: next } }, { upsert: true });
  await writeAudit(ctx, "NoticeSettingsChanged", { companyId, module: "CRM-01", before, after: next });
  return { status: 200, body: { ok: true, settings: next } };
}

async function patchNoticesByIdRead(ctx) {
  const r = await repo.notices.updateOne({ _id: oid(ctx.params.id), userId: ctx.user._id }, { $set: { read: true, readAt: new Date() } });
  if (!r.matchedCount) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: { ok: true } };
}

async function postNoticesReadAll(ctx) {
  const r = await repo.notices.updateMany({ userId: ctx.user._id, companyId: oid(ctx.user.companyId), read: false }, { $set: { read: true, readAt: new Date() } });
  return { status: 200, body: { ok: true, updated: r.modifiedCount } };
}

module.exports = { isAdminLayer, noticeSettings, sendOutside, notify, officeDesk, companyAdmins, franchiseUsers, notifyFranchise, sweepNotices, getNotices, getNoticesSettings, patchNoticesSettings, patchNoticesByIdRead, postNoticesReadAll };
