const { buildMime } = require("../../adapters/mail-mime");
const config = require("../../config/env");
const { isFranchiseNetwork, can, isFieldStaff } = require("../../middlewares/rbac");
const { canViewComplaint, historyEntry, isDesk } = require("../complaints/complaints.service");
const { toPublic, TRANSPORT, EMAIL_RE, TEMPLATE_KEYS, DEFAULT_TEMPLATES, MAX_ATTACH_BYTES, MAX_RETRIES, SYSTEM_REQ, DOCKET_RE, VARIANTS, STATUSES, REPLY_STATES, REPLY_WAIT_HOURS, BOUNCE_RE, replyState } = require("./mail.model");
const repo = require("./mail.repository");
const nextVersion = (...args) => require("../documents/documents.service").nextVersion(...args);
const { isAdmin } = require("../ops/ops.service");
const { createTask } = require("../tasks/tasks.service");
const { writeAudit } = require("../../utils/audit-writer");
const { csvCell } = require("../../utils/csv");
const { istToday, normDate } = require("../../utils/dates");
const { readFileData, storeFile, removeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

async function deliver(mail) {
  if (TRANSPORT === "demo") {
    const bad = [...mail.to, ...mail.cc, ...mail.bcc].find((a) => a.endsWith(".invalid"));
    if (bad) return { ok: false, error: "demo transport: " + bad + " rejected" };
    return { ok: true, messageId: "<" + mail._id + "." + Date.now() + "@demo.advocateflow>" };
  }
  if (TRANSPORT === "smtp") {
    const { smtpSend, mailDomain } = require("../../adapters/smtp");
    const docs = (mail.attachmentIds || []).length ? await repo.documents.list({ _id: { $in: mail.attachmentIds } }) : [];
    const files = [];
    for (const d of docs) files.push({ name: d.fileName, mime: d.mime || "application/octet-stream", data: await readFileData(d) });
    const from = mail.from || config.MAIL_FROM || config.SMTP_USER || "";
    const messageId = "<" + mail._id + "." + Date.now() + "@" + mailDomain(from) + ">";
    try {
      await smtpSend({ from, rcpt: [...mail.to, ...mail.cc, ...mail.bcc], data: buildMime({ ...mail, from }, messageId, files) });
      return { ok: true, messageId };
    } catch (err) {
      return /^5\d\d/.test(err.message) ? { ok: false, error: "smtp: " + err.message } : { ok: false, queued: true, error: "smtp: " + err.message };
    }
  }
  return { ok: false, queued: true, error: "no mail gateway connected; message stays queued" };
}

function addresses(v, label, errors) {
  const list = (Array.isArray(v) ? v : String(v || "").split(/[,;]/))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((a) => !EMAIL_RE.test(a));
  if (bad.length) errors.push(label + ": not an email address — " + bad.join(", "));
  return [...new Set(list)];
}

function render(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));
}

function ticketVars(c) {
  return { docket: c.docketNumber, atmId: c.atmId, franchise: c.franchiseName || "", status: c.status, subject: c.subject, siteId: c.siteId || "", city: c.city || "", today: istToday() };
}

async function templates(companyId) {
  const saved = await repo.mail_templates.list({ companyId });
  return TEMPLATE_KEYS.map((key) => ({ key, ...DEFAULT_TEMPLATES[key], ...(saved.find((t) => t.key === key) || {}) }));
}

async function signature(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  return lu.mailSignature || "";
}

function sameCompany(ctx, companyId) {
  return !!companyId && String(companyId) === String(ctx.user.companyId);
}

async function loadTicket(ctx, id) {
  const c = await repo.complaints.findById(oid(id));
  return c && sameCompany(ctx, c.companyId) && (await canViewComplaint(ctx.user, c)) ? c : null;
}

function publicMail(m, desk) {
  const out = toPublic(m, desk);
  return out ? { ...out, replyState: replyState(out) } : out;
}

async function trackerFile(file) {
  if (!file || !file.data) return null;
  const f = checkFile(file.fileName, file.data, MAX_ATTACH_BYTES);
  if (f.error) return { error: f.error };
  return { fileName: f.name, mime: f.mime, ...(await storeFile(f.data, f.name, f.mime)) };
}

async function saveAttachment(ctx, mail, file) {
  const f = checkFile(file.fileName, file.data, MAX_ATTACH_BYTES);
  if (f.error) return { error: "attachment: " + f.error };
  const stored = await storeFile(f.data, f.name, f.mime);
  file = { fileName: f.name, mime: f.mime };
  const r = await repo.documents.insert({
    companyId: mail.companyId,
    parentType: "mail",
    parentId: mail._id,
    type: "Mail attachment",
    version: 1,
    fileName: String(file.fileName || "attachment"),
    mime: String(file.mime || "application/octet-stream"),
    ...stored,
    franchiseId: mail.franchiseId || null,
    uploadedBy: ctx.user._id,
    uploadedAt: new Date(),
  });
  return { id: r.insertedId };
}

async function trySend(ctx, mail, retry) {
  const now = new Date();
  // "Sending" keeps drainQueue from picking up a mail that is being delivered right now
  await repo.mails.updateById(mail._id, { $set: { status: "Sending", queuedAt: now }, ...(retry ? { $inc: { retries: 1 } } : {}) });
  await writeAudit(ctx, retry ? "MailRetry" : "MailQueued", { companyId: mail.companyId, module: "CRM-05", recordId: mail._id, work: mail.subject + " → " + mail.to.join(", ") });
  const r = await deliver(mail);
  if (r.ok) {
    const threadId = mail.threadId || r.messageId;
    await repo.mails.updateById(mail._id, { $set: { status: "Sent", messageId: r.messageId, threadId, sentAt: new Date(), error: "", transport: TRANSPORT } });
    await writeAudit(ctx, "MailSent", { companyId: mail.companyId, module: "CRM-05", recordId: mail._id, work: r.messageId + (TRANSPORT === "demo" ? " (demo transport — not delivered)" : "") });
    if (mail.complaintId) {
      await repo.complaints.updateById(mail.complaintId, { $set: { lastAction: "Mail sent: " + mail.subject.slice(0, 80), updatedAt: new Date() }, $push: { history: historyEntry(ctx, "Mail sent", { remark: mail.subject + " → " + mail.to.join(", ") }) } });
    }
    return { status: "Sent", messageId: r.messageId };
  }
  if (r.queued && (mail.retries || 0) + (retry ? 1 : 0) < MAX_RETRIES) {
    const tries = (mail.retries || 0) + (retry ? 1 : 0);
    const nextAttemptAt = new Date(Date.now() + 5 * 60 * 1000 * 2 ** tries);
    await repo.mails.updateById(mail._id, { $set: { status: "Queued", error: r.error, transport: TRANSPORT, lastAttemptAt: now, nextAttemptAt } });
    return { status: "Queued", note: r.error };
  }
  const bounced = BOUNCE_RE.test(String(r.error || ""));
  const failStatus = bounced ? "Bounced" : "Failed";
  await repo.mails.updateById(mail._id, { $set: { status: failStatus, error: r.error, failedAt: new Date(), ...(bounced ? { bouncedAt: new Date() } : {}), transport: TRANSPORT } });
  await writeAudit(ctx, bounced ? "MailBounced" : "MailFailed", { companyId: mail.companyId, module: "CRM-05", recordId: mail._id, work: r.error });
  return { status: failStatus, error: r.error };
}

async function queueAutoMail(companyId, { templateKey, vars, to, complaintId, franchiseId, atmId, docketNumber }) {
  const list = addresses(to, "To", []);
  if (!list.length) return null;
  const tpl = (await templates(companyId)).find((t) => t.key === templateKey);
  if (!tpl) return null;
  const sig = await signature(companyId);
  const now = new Date();
  const doc = {
    companyId,
    direction: "out",
    status: "Queued",
    auto: true,
    complaintId: complaintId || null,
    docketNumber: docketNumber || "",
    atmId: atmId || "",
    franchiseId: franchiseId || null,
    templateKey,
    from: config.MAIL_FROM || "",
    to: list,
    cc: [],
    bcc: [],
    subject: render(tpl.subject, vars || {}),
    body: render(tpl.body, vars || {}) + (sig ? "\n--\n" + sig : ""),
    attachmentIds: [],
    inReplyTo: "",
    references: [],
    threadId: "",
    retries: 0,
    queuedAt: now,
    createdBy: null,
    createdByName: "system",
    createdAt: now,
    updatedAt: now,
  };
  const r = await repo.mails.insert(doc);
  return r.insertedId;
}

async function drainQueue(limit = 50) {
  if (TRANSPORT !== "smtp") return { sent: 0, queued: 0, failed: 0, skipped: "transport is " + TRANSPORT };
  const now = new Date();
  const stale = new Date(now.getTime() - 15 * 60 * 1000);
  const rows = await repo.mails.list({
      direction: "out",
      $or: [
        { status: { $in: ["Queued", "Retry"] }, $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
        { status: "Sending", queuedAt: { $lt: stale } },
      ],
    }, { sort: { queuedAt: 1 }, limit: limit });
  const out = { sent: 0, queued: 0, failed: 0 };
  for (const m of rows) {
    const claim = await repo.mails.updateOne({ _id: m._id, status: m.status, queuedAt: m.queuedAt }, { $set: { status: "Sending", queuedAt: now } });
    if (!claim.modifiedCount) continue;
    const r = await trySend({ ...SYSTEM_REQ, user: { login: "system", companyId: m.companyId } }, m, !!m.lastAttemptAt);
    if (r.status === "Sent") out.sent++;
    else if (r.status === "Queued") out.queued++;
    else out.failed++;
  }
  return out;
}

async function queueMailWithFile(companyId, { subject, body, to, file, franchiseId }) {
  const list = addresses(to, "To", []);
  if (!list.length) return null;
  const now = new Date();
  const doc = { companyId, direction: "out", status: "Queued", auto: true, complaintId: null, docketNumber: "", atmId: "", franchiseId: franchiseId || null, templateKey: "custom", from: config.MAIL_FROM || "", to: list, cc: [], bcc: [], subject, body, attachmentIds: [], inReplyTo: "", references: [], threadId: "", retries: 0, queuedAt: now, createdBy: null, createdByName: "system", createdAt: now, updatedAt: now };
  const r = await repo.mails.insert(doc);
  const fileName = file.name || file.fileName;
  const stored = await storeFile(file.data, fileName, file.mime);
  const d = await repo.documents.insert({ companyId, parentType: "mail", parentId: r.insertedId, type: "Mail attachment", version: 1, fileName, mime: file.mime, ...stored, franchiseId: franchiseId || null, uploadedBy: null, uploadedAt: now });
  await repo.mails.updateById(r.insertedId, { $set: { attachmentIds: [d.insertedId] } });
  return r.insertedId;
}

async function receiveInbound(ctx, companyId, b, opts = {}) {
  const errors = [];
  const from = addresses(b.from, "From", errors)[0];
  if (!from) errors.push("From required");
  const messageId = String(b.messageId || "").trim();
  if (!messageId) errors.push("Message ID required");
  const subject = String(b.subject || "").trim();
  if (errors.length) return { status: 400, body: { error: errors.join("; ") } };
  if (await repo.mails.findOne({ companyId, messageId })) return { status: 409, body: { error: "this message is already recorded" } };
  const inbound = {
    from,
    to: addresses(b.to, "To", []),
    subject,
    body: String(b.body || ""),
    messageId,
    inReplyTo: String(b.inReplyTo || "").trim(),
    references: (Array.isArray(b.references) ? b.references : String(b.references || "").split(/\s+/)).map((s) => String(s).trim()).filter(Boolean),
    docket: b.docket,
    atmId: b.atmId,
  };
  const map = (await mapInbound(companyId, inbound)) || { by: "unmapped" };
  let doc;
  try {
    doc = await recordReply(ctx, companyId, inbound, map);
  } catch (err) {
    if (err && err.code === 11000) return { status: 409, body: { error: "this message is already recorded" } };
    throw err;
  }
  if (opts.via) await repo.mails.updateById(doc._id, { $set: { receivedVia: opts.via } });
  let mappedBy = map.by;
  let ticket = null;
  if (opts.via && !doc.complaintId && !map.parent) {
    const t = await require("../complaints/complaints.service").ticketFromMail(companyId, doc).catch((err) => ({ skipped: "error: " + err.message }));
    if (t && t.complaint) {
      const c = t.complaint;
      mappedBy = t.by;
      await repo.mails.updateById(doc._id, { $set: { complaintId: c._id, docketNumber: c.docketNumber, atmId: c.atmId, franchiseId: c.franchiseId || null, mappedBy, autoTicket: !!t.created } });
      Object.assign(doc, { complaintId: c._id, docketNumber: c.docketNumber, atmId: c.atmId, franchiseId: c.franchiseId || null });
      ticket = { docketNumber: c.docketNumber, created: !!t.created };
      await writeAudit(ctx, "ReplyMapped", { companyId, module: "CRM-05", recordId: doc._id, work: c.docketNumber + " via " + mappedBy });
    } else if (t && t.skipped) {
      await repo.mails.updateById(doc._id, { $set: { autoTicketSkipped: t.skipped } });
    }
  }
  let task = null;
  if (!b.createTask) {
    const auto = await require("../tasks/tasks.service").taskFromMailRules(companyId, doc).catch(() => null);
    if (auto) {
      task = auto.taskNo;
      await repo.mails.updateById(doc._id, { $set: { taskId: auto._id } });
      await writeAudit(ctx, "TaskCreated", { companyId, module: "CRM-06", recordId: auto._id, work: auto.taskNo + " from mail rule, " + messageId });
    }
  }
  if (b.createTask && doc.complaintId) {
    const r = await createTask(companyId, ctx.user, { title: "Mail: " + (subject || "(no subject)").slice(0, 80), description: doc.body.slice(0, 2000), source: "Email", complaintId: doc.complaintId, atmId: doc.atmId, category: "Office", type: "Service" });
    if (r.error) return { status: 400, body: { error: "reply saved, task not created: " + r.error, id: String(doc._id) } };
    if (r.task) {
      task = r.task.taskNo;
      await repo.mails.updateById(doc._id, { $set: { taskId: r.task._id } });
      await writeAudit(ctx, "TaskCreated", { companyId, module: "CRM-06", recordId: r.task._id, work: r.task.taskNo + " from mail " + messageId });
    }
  }
  return { status: 200, body: { id: String(doc._id), mapped: !!doc.complaintId, mappedBy, docketNumber: doc.docketNumber, ticket, task } };
}

async function franchiseEmail(companyId, franchiseId, atm) {
  const fr = franchiseId ? await repo.franchises.findOne({ _id: oid(franchiseId), companyId }) : null;
  return [fr && fr.email, atm && atm.email].filter(Boolean);
}

async function mapInbound(companyId, m) {
  const refs = [m.inReplyTo, ...(m.references || [])].filter(Boolean);
  if (refs.length) {
    const parent = await repo.mails.findOne({ companyId, direction: "out", $or: [{ messageId: { $in: refs } }, { threadId: { $in: refs } }] }, { sort: { sentAt: -1 } });
    if (parent) return { parent, complaintId: parent.complaintId || null, by: "Message / Thread ID" };
  }
  const docket = (DOCKET_RE.exec(m.subject + " " + m.body) || [])[0] || String(m.docket || "").trim();
  if (docket) {
    const c = await repo.complaints.findOne({ companyId, docketNumber: docket });
    if (c) return { complaintId: c._id, by: "Docket " + docket };
  }
  const atmId = String(m.atmId || "").trim();
  if (atmId) {
    const open = await repo.complaints.list({ companyId, atmId, status: { $nin: ["Resolved", "Closed"] } }, { projection: { _id: 1 }, limit: 2 });
    if (open.length === 1) return { complaintId: open[0]._id, by: "ATM " + atmId + " (only open ticket)" };
  }
  return null;
}

async function recordReply(ctx, companyId, inbound, map) {
  const now = new Date();
  const complaint = map.complaintId ? await repo.complaints.findOne({ _id: map.complaintId, companyId }) : null;
  const doc = {
    companyId,
    direction: "in",
    status: "Reply Received",
    complaintId: complaint ? complaint._id : null,
    docketNumber: complaint ? complaint.docketNumber : "",
    atmId: complaint ? complaint.atmId : String(inbound.atmId || ""),
    franchiseId: complaint ? complaint.franchiseId : null,
    from: inbound.from,
    to: inbound.to || [],
    cc: [],
    bcc: [],
    subject: inbound.subject,
    body: inbound.body,
    messageId: inbound.messageId,
    inReplyTo: inbound.inReplyTo || (map.parent && map.parent.messageId) || "",
    references: inbound.references || [],
    threadId: map.parent ? map.parent.threadId : inbound.messageId,
    mappedBy: map.by,
    receivedAt: now,
    createdBy: ctx.user._id,
    createdAt: now,
  };
  const r = await repo.mails.insert(doc);
  doc._id = r.insertedId;
  if (map.parent) await repo.mails.updateById(map.parent._id, { $set: { status: "Reply Received", repliedAt: now } });
  if (complaint) {
    await repo.complaints.updateById(complaint._id, { $set: { lastAction: "Reply from " + doc.from + ": " + doc.subject.slice(0, 60), updatedAt: now }, $push: { history: historyEntry(ctx, "Mail reply", { remark: doc.from + " — " + doc.subject }) } });
    const ns = require("../notices/notices.service");
    const to = [complaint.ownerUserId, ...(complaint.ownerUserId ? [] : await ns.officeDesk(companyId))].filter((x) => x && String(x) !== String(ctx.user._id));
    await ns.notify(companyId, to, { kind: "complaint", title: "Mail reply on " + complaint.docketNumber, body: doc.from + " — " + doc.subject.slice(0, 120), link: { page: "service", id: String(complaint._id), type: "complaint" }, key: "mail-reply:" + doc._id }).catch(() => {});
  }
  await writeAudit(ctx, "ReplyMapped", { companyId, module: "CRM-05", recordId: doc._id, work: (complaint ? complaint.docketNumber : "no ticket") + " via " + map.by });
  return doc;
}

function pvcStatus(row) {
  if (!row.expiry) return "";
  const today = istToday();
  if (row.expiry < today) return "Expired";
  const soon = new Date(new Date(today + "T00:00:00Z").getTime() + 30 * 86400000).toISOString().slice(0, 10);
  return row.expiry <= soon ? "Renewal Due" : "Active";
}

async function trackerRows(ctx, variant, month) {
  const companyId = oid(ctx.user.companyId);
  const range = { $gte: new Date(month + "-01T00:00:00+05:30"), $lt: new Date(nextMonth(month) + "-01T00:00:00+05:30") };
  const scope = { companyId };
  await applyFranchiseFilter(ctx.user, scope, "franchiseId");
  const ist = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().replace("T", " ").slice(0, 16) : "");
  if (variant === "complaint") {
    const mails = await repo.mails.list({ ...scope, direction: "out", complaintId: { $ne: null }, status: { $ne: "Draft" }, createdAt: range }, { sort: { createdAt: 1 } });
    const tickets = await repo.complaints.list({ _id: { $in: [...new Set(mails.map((m) => String(m.complaintId)))].map(oid) } }, { projection: { docketNumber: 1, createdAt: 1 } });
    const firstSent = new Map();
    mails.filter((m) => m.sentAt).forEach((m) => !firstSent.has(String(m.complaintId)) && firstSent.set(String(m.complaintId), m));
    return mails.map((m) => {
      const t = tickets.find((x) => String(x._id) === String(m.complaintId));
      const first = firstSent.get(String(m.complaintId));
      const inTime = !!(t && first && new Date(first.sentAt) - new Date(t.createdAt) <= 4 * 3600000 && (first.subject + first.body).includes(t.docketNumber));
      return { date: ist(m.sentAt || m.createdAt), atmId: m.atmId, subject: m.subject, docketNumber: m.docketNumber, docketIn4Hours: t ? (inTime ? "Yes" : "No") : "", status: m.status };
    });
  }
  if (variant === "calling") {
    const list = await repo.complaints.list({ ...scope, "history.action": "Remark", createdAt: range }, { projection: { atmId: 1, siteId: 1, city: 1, franchiseName: 1, docketNumber: 1, history: 1 } });
    const manual = await repo.tracker_rows.list({ ...scope, variant, month }, { sort: { createdAt: 1 } });
    return [
      ...list.map((c) => ({
        atmId: c.atmId,
        siteId: c.siteId || "",
        city: c.city || "",
        franchise: c.franchiseName || "",
        docketNumber: c.docketNumber,
        remarks: c.history
          .filter((h) => h.action === "Remark")
          .map((h) => ist(h.at).slice(0, 10) + " " + h.remark)
          .join("; "),
      })),
      ...manual.map((r) => ({ _id: r._id, atmId: r.atmId, siteId: r.siteId || "", city: "", franchise: r.franchiseName || "", docketNumber: "", remarks: [r.callDate, r.calledBy, r.remarks].filter(Boolean).join(" · ") })),
    ];
  }
  if (variant === "cbr") {
    const mails = await repo.mails.list({ ...scope, direction: "out", templateKey: "cbr", status: { $ne: "Draft" }, createdAt: range }, { sort: { createdAt: 1 } });
    return mails.map((m) => ({ sentDate: ist(m.sentAt).slice(0, 10), atmId: m.atmId, subject: m.subject, status: m.status }));
  }
  const rows = await repo.tracker_rows.list({ ...scope, variant, month }, { sort: { createdAt: 1 } });
  const files = rows.length ? await repo.documents.list({ parentType: "trackerRow", parentId: { $in: rows.map((r) => r._id) } }, { projection: { data: 0 } }) : [];
  return rows.map((r) => ({
    _id: r._id,
    ...Object.fromEntries(VARIANTS[variant].fields.map((f) => [f, r[f] === undefined ? "" : r[f]])),
    franchise: r.franchiseName || "",
    ...(variant === "pvc" ? { status: pvcStatus(r) } : {}),
    files: files.filter((d) => String(d.parentId) === String(r._id)).map((d) => ({ _id: d._id, fileName: d.fileName })),
  }));
}

function nextMonth(m) {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? y + 1 + "-01" : y + "-" + String(mo + 1).padStart(2, "0");
}

async function trackerInput(ctx, variant, body, existing) {
  const companyId = oid(ctx.user.companyId);
  const errors = [];
  const out = {};
  const atmId = String(body.atmId !== undefined ? body.atmId : (existing && existing.atmId) || "").trim();
  if (!atmId) errors.push("ATM ID required");
  const atm = atmId ? await repo.atms.findOne({ companyId, atmId }) : null;
  if (atmId && !atm) errors.push("ATM " + atmId + " is not in this company's ATM Master");
  if (atm) {
    out.atmId = atm.atmId;
    out.franchiseId = atm.franchiseId || null;
    out.franchiseName = atm.franchiseeName || "";
    if (!body.siteId && !(existing && existing.siteId)) out.siteId = atm.siteId || "";
  }
  for (const f of VARIANTS[variant].fields) {
    if (f === "atmId" || body[f] === undefined) continue;
    const v = String(body[f]).trim();
    if (f === "days") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) errors.push("days must be a whole number ≥ 0");
      out.days = n;
    } else if (f === "penalty") {
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) errors.push("penalty must be 0 or more");
      out.penalty = Math.round(n * 100) / 100;
    } else if (f === "pvcDate" || f === "expiry" || f === "callDate") {
      const d = v ? normDate(v) : "";
      if (v && !d) errors.push(f + " must be YYYY-MM-DD or DD.MM.YYYY");
      out[f] = d;
    } else out[f] = v;
  }
  const pvcDate = out.pvcDate !== undefined ? out.pvcDate : existing && existing.pvcDate;
  const expiry = out.expiry !== undefined ? out.expiry : existing && existing.expiry;
  if (variant === "pvc" && pvcDate && expiry && expiry < pvcDate) errors.push("expiry is before the PVC date");
  return { errors, out };
}

async function getMailMeta(ctx) {
  const companyId = oid(ctx.user.companyId);
  return { status: 200, body: {
    statuses: STATUSES,
    replyStates: REPLY_STATES,
    replyWaitHours: REPLY_WAIT_HOURS,
    variants: Object.entries(VARIANTS).map(([key, v]) => ({ key, label: v.label, fields: v.fields || null })),
    templates: await templates(companyId),
    signature: await signature(companyId),
    transport: TRANSPORT,
    mailbox: ctx.user.mailbox || null,
    desk: isDesk(ctx.user),
    admin: isAdmin(ctx.user),
    canCompose: can(ctx.user, "Create", "CRM-05") && !isFranchiseNetwork(ctx.user) && !isFieldStaff(ctx.user),
    canDiscardAny: can(ctx.user, "Delete", "CRM-05"),
    me: String(ctx.user._id),
    month: istToday().slice(0, 7),
    problemTypes: [...new Set((await require("../complaints/complaints.service").taxonomy(companyId)).flatMap((c) => c.problemTypes || []))],
  } };
}

async function postMailMailbox(ctx) {
  if (ctx.body.password !== undefined) return { status: 400, body: { error: "mailbox passwords are never stored" } };
  const address = String(ctx.body.address || "").trim().toLowerCase();
  if (!address) {
    await repo.users.updateById(ctx.user._id, { $unset: { mailbox: "" } });
    await writeAudit(ctx, "MailboxConnected", { module: "CRM-05", work: "disconnected" });
    return { status: 200, body: { ok: true, mailbox: null } };
  }
  if (!EMAIL_RE.test(address)) return { status: 400, body: { error: "not an email address" } };
  const mailbox = { address, connectedAt: new Date(), transport: TRANSPORT };
  await repo.users.updateById(ctx.user._id, { $set: { mailbox } });
  await writeAudit(ctx, "MailboxConnected", { module: "CRM-05", work: address + " (" + TRANSPORT + ")" });
  return { status: 200, body: { ok: true, mailbox } };
}

async function putMailTemplatesByKey(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin maintains templates" } };
  const key = ctx.params.key;
  if (!TEMPLATE_KEYS.includes(key)) return { status: 404, body: { error: "unknown template" } };
  const companyId = oid(ctx.user.companyId);
  const set = { name: String(ctx.body.name || DEFAULT_TEMPLATES[key].name).trim(), subject: String(ctx.body.subject || "").trim(), body: String(ctx.body.body || ""), updatedBy: ctx.user._id, updatedAt: new Date() };
  if (key !== "custom" && (!set.subject || !set.body.trim())) return { status: 400, body: { error: "subject and body required" } };
  await repo.mail_templates.updateOne({ companyId, key }, { $set: set }, { upsert: true });
  await writeAudit(ctx, "MailTemplateSaved", { companyId, module: "CRM-05", work: key, after: set });
  return { status: 200, body: { ok: true } };
}

async function putMailSignature(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin maintains the signature" } };
  const companyId = oid(ctx.user.companyId);
  const text = String(ctx.body.signature || "").slice(0, 2000);
  await repo.lookups.updateOne({ companyId }, { $set: { mailSignature: text } }, { upsert: true });
  await writeAudit(ctx, "MailTemplateSaved", { companyId, module: "CRM-05", work: "signature" });
  return { status: 200, body: { ok: true } };
}

async function postMailRender(ctx) {
  const companyId = oid(ctx.user.companyId);
  const tpl = (await templates(companyId)).find((t) => t.key === ctx.body.templateKey);
  if (!tpl) return { status: 404, body: { error: "unknown template" } };
  const c = ctx.body.complaintId ? await loadTicket(ctx, ctx.body.complaintId) : null;
  if (ctx.body.complaintId && !c) return { status: 404, body: { error: "ticket not found" } };
  const vars = c ? ticketVars(c) : { today: istToday(), atmId: String(ctx.body.atmId || "") };
  const sig = await signature(companyId);
  return { status: 200, body: { subject: render(tpl.subject, vars), body: render(tpl.body, vars) + (sig ? "\n--\n" + sig : ""), to: c && c.frEmail ? [c.frEmail] : [] } };
}

async function getMail(ctx) {
  const filter = { companyId: oid(ctx.user.companyId) };
  const desk = isDesk(ctx.user);
  if (ctx.query.complaintId) {
    const c = await loadTicket(ctx, ctx.query.complaintId);
    if (!c) return { status: 404, body: { error: "ticket not found" } };
    filter.complaintId = c._id;
  } else if (!desk) {
    if (isFranchiseNetwork(ctx.user)) {
      await applyFranchiseFilter(ctx.user, filter, "franchiseId");
      filter.complaintId = { $ne: null };
    } else filter.createdBy = ctx.user._id;
  }
  if (STATUSES.includes(ctx.query.status)) filter.status = ctx.query.status;
  else if (REPLY_STATES.includes(ctx.query.status)) {
    const cutoff = new Date(Date.now() - REPLY_WAIT_HOURS * 3600000);
    Object.assign(filter, { direction: "out", status: "Sent", repliedAt: { $in: [null] }, sentAt: ctx.query.status === "No Reply" ? { $lt: cutoff } : { $gte: cutoff } });
    if (!filter.complaintId) filter.complaintId = { $ne: null };
  }
  if (ctx.query.direction === "in" || ctx.query.direction === "out") filter.direction = ctx.query.direction;
  if (ctx.query.unmapped && desk) Object.assign(filter, { direction: "in", complaintId: null });
  if (isFranchiseNetwork(ctx.user)) (filter.$and = filter.$and || []).push({ status: { $in: ["Sent", "Reply Received"] } });
  else if (!desk) (filter.$and = filter.$and || []).push({ $or: [{ status: { $ne: "Draft" } }, { status: "Draft", createdBy: ctx.user._id }] });
  const rows = await repo.mails.list(filter, { sort: { createdAt: -1 }, limit: 300 });
  const files = rows.length ? await repo.documents.list({ parentType: "mail", parentId: { $in: rows.map((m) => m._id) } }, { projection: { data: 0 } }) : [];
  return { status: 200, body: {
    rows: rows.map((m) => ({ ...publicMail(m, desk), files: files.filter((d) => String(d.parentId) === String(m._id)).map((d) => ({ _id: d._id, fileName: d.fileName })) })),
  } };
}

async function postMail(ctx) {
  if (isFranchiseNetwork(ctx.user)) return { status: 403, body: { error: "franchisees reply on their own thread" } };
  if (!can(ctx.user, "Create", "CRM-05")) return { status: 403, body: { error: "not allowed" } };
  const b = ctx.body;
  const companyId = oid(ctx.user.companyId);
  const c = b.complaintId ? await loadTicket(ctx, b.complaintId) : null;
  if (b.complaintId && !c) return { status: 404, body: { error: "ticket not found" } };
  if (!c && !isDesk(ctx.user)) return { status: 403, body: { error: "mail without a ticket is service desk only" } };
  const errors = [];
  const to = addresses(b.to, "To", errors);
  const cc = addresses(b.cc, "CC", errors);
  const bcc = addresses(b.bcc, "BCC", errors);
  const subject = String(b.subject || "").trim();
  const draft = !!b.draft;
  if (!draft && !to.length) errors.push("To required");
  if (!draft && !subject) errors.push("subject required");
  if (errors.length) return { status: 400, body: { error: errors.join("; ") } };
  if (!draft && !(ctx.user.mailbox && ctx.user.mailbox.address)) return { status: 400, body: { error: "connect your mailbox before sending (drafts are allowed)" } };
  let parent = null;
  if (b.replyToId) {
    parent = await repo.mails.findOne({ _id: oid(b.replyToId), companyId });
    if (!parent || (c && String(parent.complaintId) !== String(c._id))) return { status: 400, body: { error: "reply must be on the same ticket thread" } };
  }
  const templateKey = TEMPLATE_KEYS.includes(b.templateKey) ? b.templateKey : "custom";
  const atm = !c && b.atmId ? await repo.atms.findOne({ companyId, atmId: String(b.atmId).trim() }) : null;
  if (!c && b.atmId && !atm) return { status: 400, body: { error: "ATM not in this company" } };
  const now = new Date();
  const mail = {
    companyId,
    direction: "out",
    status: "Draft",
    complaintId: c ? c._id : null,
    docketNumber: c ? c.docketNumber : "",
    atmId: c ? c.atmId : atm ? atm.atmId : "",
    franchiseId: c ? c.franchiseId : atm ? atm.franchiseId || null : null,
    templateKey,
    from: (ctx.user.mailbox && ctx.user.mailbox.address) || "",
    to,
    cc,
    bcc,
    subject,
    body: String(b.body || ""),
    attachmentIds: [],
    inReplyTo: parent ? parent.messageId || "" : "",
    references: parent ? [...(parent.references || []), parent.messageId].filter(Boolean) : [],
    threadId: parent ? parent.threadId || "" : "",
    retries: 0,
    createdBy: ctx.user._id,
    createdByName: ctx.user.name,
    createdAt: now,
    updatedAt: now,
  };
  if (Array.isArray(b.attachmentIds) && b.attachmentIds.length) {
    if (!c) return { status: 400, body: { error: "attach ticket files only on a ticket mail" } };
    const visits = await repo.visits.list({ complaintId: c._id }, { projection: { _id: 1 } });
    const docs = await repo.documents.list({ _id: { $in: b.attachmentIds.map(oid).filter(Boolean) }, companyId, parentId: { $in: [c._id, ...visits.map((v) => v._id)] } }, { projection: { _id: 1 } });
    if (docs.length !== b.attachmentIds.length) return { status: 400, body: { error: "attachments must be files of this ticket" } };
    mail.attachmentIds = docs.map((d) => d._id);
  }
  const r = await repo.mails.insert(mail);
  mail._id = r.insertedId;
  if (b.file && b.file.data) {
    const a = await saveAttachment(ctx, mail, b.file);
    if (a.error) {
      await repo.mails.deleteById(mail._id);
      return { status: 400, body: { error: a.error } };
    }
    mail.attachmentIds = [...mail.attachmentIds, a.id];
    await repo.mails.updateById(mail._id, { $push: { attachmentIds: a.id } });
  }
  if (draft) return { status: 200, body: { id: String(mail._id), status: "Draft" } };
  const sent = await trySend(ctx, mail, false);
  return { status: 200, body: { id: String(mail._id), ...sent } };
}

async function patchMailById(ctx) {
  const m = await repo.mails.findById(oid(ctx.params.id));
  if (!m || !sameCompany(ctx, m.companyId) || m.direction !== "out") return { status: 404, body: { error: "not found" } };
  if (m.complaintId && !(await loadTicket(ctx, m.complaintId))) return { status: 404, body: { error: "not found" } };
  const mine = String(m.createdBy) === String(ctx.user._id);
  if (!mine && !isDesk(ctx.user)) return { status: 403, body: { error: "your own mail or service desk only" } };
  const action = ctx.body.action;
  if (action === "edit" || action === "send") {
    if (m.status !== "Draft") return { status: 400, body: { error: "only a draft can be edited or sent" } };
    const errors = [];
    const set = { updatedAt: new Date() };
    if (ctx.body.to !== undefined) set.to = addresses(ctx.body.to, "To", errors);
    if (ctx.body.cc !== undefined) set.cc = addresses(ctx.body.cc, "CC", errors);
    if (ctx.body.bcc !== undefined) set.bcc = addresses(ctx.body.bcc, "BCC", errors);
    if (ctx.body.subject !== undefined) set.subject = String(ctx.body.subject).trim();
    if (ctx.body.body !== undefined) set.body = String(ctx.body.body);
    if (errors.length) return { status: 400, body: { error: errors.join("; ") } };
    const merged = { ...m, ...set };
    if (action === "send") {
      if (!merged.to.length || !merged.subject) return { status: 400, body: { error: "To and subject required to send" } };
      if (!(ctx.user.mailbox && ctx.user.mailbox.address)) return { status: 400, body: { error: "connect your mailbox before sending" } };
      set.from = ctx.user.mailbox.address;
    }
    const claim = await repo.mails.updateOne({ _id: m._id, status: "Draft" }, { $set: action === "send" ? { ...set, status: "Sending" } : set });
    if (!claim.matchedCount) return { status: 409, body: { error: "mail changed (already sent?); reload" } };
    if (action === "edit") return { status: 200, body: { ok: true, status: "Draft" } };
    return { status: 200, body: { ok: true, ...(await trySend(ctx, { ...merged, ...set }, false)) } };
  }
  if (action === "bounce") {
    if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk only" } };
    if (m.status !== "Sent") return { status: 400, body: { error: "only a Sent mail can be marked bounced" } };
    const reason = String(ctx.body.reason || "").trim();
    if (!reason) return { status: 400, body: { error: "bounce reason required (paste the bounce notice)" } };
    const upd = await repo.mails.updateOne({ _id: m._id, status: "Sent" }, { $set: { status: "Bounced", error: reason.slice(0, 500), bouncedAt: new Date(), updatedAt: new Date() } });
    if (!upd.modifiedCount) return { status: 409, body: { error: "mail changed; reload" } };
    await writeAudit(ctx, "MailBounced", { companyId: m.companyId, module: "CRM-05", recordId: m._id, before: { status: "Sent" }, after: { status: "Bounced" }, work: reason.slice(0, 200) });
    return { status: 200, body: { ok: true, status: "Bounced" } };
  }
  if (action === "retry") {
    if (m.status !== "Failed") return { status: 400, body: { error: "only a Failed mail can be retried" } };
    if ((m.retries || 0) >= MAX_RETRIES) return { status: 400, body: { error: "retried " + MAX_RETRIES + " times; fix the addresses and send a new mail" } };
    const upd = await repo.mails.updateOne({ _id: m._id, status: "Failed" }, { $set: { status: "Retry" } });
    if (!upd.modifiedCount) return { status: 409, body: { error: "mail changed; reload" } };
    return { status: 200, body: { ok: true, ...(await trySend(ctx, m, true)) } };
  }
  if (action === "discard") {
    if (m.status !== "Draft") return { status: 400, body: { error: "only a draft can be discarded" } };
    if (String(m.createdBy) !== String(ctx.user._id) && !can(ctx.user, "Delete", "CRM-05")) return { status: 403, body: { error: "Delete action not granted" } };
    await repo.mails.deleteById(m._id);
    const attached = await repo.documents.list({ parentType: "mail", parentId: m._id }, { projection: { fileId: 1 } });
    for (const d of attached) await removeFile(d);
    const files = await repo.documents.deleteMany({ parentType: "mail", parentId: m._id });
    await writeAudit(ctx, "MailDraftDiscarded", { companyId: m.companyId, module: "CRM-05", recordId: m._id, before: { to: m.to, subject: m.subject, complaintId: m.complaintId || null, attachments: files.deletedCount }, work: m.subject || "" });
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: "action must be edit, send, retry, bounce or discard" } };
}

async function postMailInbound(ctx) {
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk records received mail" } };
  const r = await receiveInbound(ctx, oid(ctx.user.companyId), ctx.body);
  return { status: r.status, body: r.body };
}

async function patchMailByIdMap(ctx) {
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk only" } };
  const m = await repo.mails.findOne({ _id: oid(ctx.params.id), direction: "in" });
  if (!m || !sameCompany(ctx, m.companyId)) return { status: 404, body: { error: "not found" } };
  if (m.complaintId) return { status: 400, body: { error: "already on docket " + m.docketNumber } };
  const c = await repo.complaints.findOne({ companyId: m.companyId, docketNumber: String(ctx.body.docketNumber || "").trim() });
  if (!c) return { status: 404, body: { error: "docket not found in this company" } };
  await repo.mails.updateById(m._id, { $set: { complaintId: c._id, docketNumber: c.docketNumber, atmId: c.atmId, franchiseId: c.franchiseId, mappedBy: "manual by " + ctx.user.login } });
  await repo.complaints.updateById(c._id, { $push: { history: historyEntry(ctx, "Mail reply", { remark: m.from + " — " + m.subject + " (mapped by hand)" }) } });
  await writeAudit(ctx, "ReplyMapped", { companyId: m.companyId, module: "CRM-05", recordId: m._id, work: c.docketNumber + " by hand" });
  return { status: 200, body: { ok: true } };
}

async function postMailByIdTicket(ctx) {
  if (!isDesk(ctx.user) || !can(ctx.user, "Create", "CRM-05")) return { status: 403, body: { error: "service desk only" } };
  const m = await repo.mails.findOne({ _id: oid(ctx.params.id), direction: "in" });
  if (!m || !sameCompany(ctx, m.companyId)) return { status: 404, body: { error: "not found" } };
  if (m.complaintId) return { status: 400, body: { error: "already on docket " + m.docketNumber } };
  const { createComplaint } = require("../complaints/complaints.service");
  const r = await createComplaint(ctx, {
    atmId: ctx.body.atmId || m.atmId,
    problemType: ctx.body.problemType,
    subject: String(ctx.body.subject || m.subject || "").trim() || "Mail from " + m.from,
    description: m.body.slice(0, 4000),
    channel: "Mail",
    frEmail: m.from,
    priority: ctx.body.priority,
  });
  if (r.status && r.status !== 200) return { status: r.status, body: r.json };
  const c = await repo.complaints.findById(oid(r.json.id));
  await repo.mails.updateById(m._id, { $set: { complaintId: c._id, docketNumber: c.docketNumber, atmId: c.atmId, franchiseId: c.franchiseId, mappedBy: "ticket created from mail by " + ctx.user.login } });
  await repo.complaints.updateById(c._id, { $set: { sourceMailId: m._id }, $push: { history: historyEntry(ctx, "Mail reply", { remark: "Ticket raised from mail " + m.from + " — " + m.subject }) } });
  await writeAudit(ctx, "TicketFromMail", { companyId: m.companyId, module: "CRM-05", recordId: c._id, work: c.docketNumber + " from " + m.messageId });
  return { status: 200, body: { id: String(c._id), docketNumber: c.docketNumber } };
}

async function postMailByIdReply(ctx) {
  const parent = await repo.mails.findOne({ _id: oid(ctx.params.id), direction: "out" });
  if (!parent || !sameCompany(ctx, parent.companyId) || !parent.complaintId || !parent.sentAt) return { status: 404, body: { error: "not found" } };
  if (!isFranchiseNetwork(ctx.user)) return { status: 403, body: { error: "office users reply by composing on the ticket" } };
  const c = await loadTicket(ctx, parent.complaintId);
  if (!c) return { status: 404, body: { error: "not found" } };
  const body = String(ctx.body.body || "").trim();
  if (!body) return { status: 400, body: { error: "reply text required" } };
  const inbound = {
    from: (ctx.user.mailbox && ctx.user.mailbox.address) || ctx.user.login,
    to: [parent.from].filter(Boolean),
    subject: "Re: " + parent.subject,
    body,
    messageId: "<reply." + parent._id + "." + Date.now() + "@crm>",
    inReplyTo: parent.messageId,
    references: [...(parent.references || []), parent.messageId].filter(Boolean),
  };
  const doc = await recordReply(ctx, parent.companyId, inbound, { parent, complaintId: c._id, by: "franchisee reply in CRM" });
  return { status: 200, body: { id: String(doc._id) } };
}

async function getMailTrackerByVariant(ctx) {
  const variant = ctx.params.variant;
  if (!VARIANTS[variant]) return { status: 404, body: { error: "unknown tracker" } };
  if (isFieldStaff(ctx.user)) return { status: 403, body: { error: "trackers are for office and franchise users" } };
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ctx.query.month)) ? String(ctx.query.month) : istToday().slice(0, 7);
  const rows = await trackerRows(ctx, variant, month);
  if (ctx.query.csv) {
    if (!isAdmin(ctx.user) && !can(ctx.user, "Export", "CRM-05")) return { status: 403, body: { error: "Export not granted" } };
    const cols = rows.length ? Object.keys(rows[0]).filter((k) => k !== "_id" && k !== "files") : VARIANTS[variant].fields || [];
    const csv = "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(","))].join("\n");
    await writeAudit(ctx, "ReportExported", { module: "CRM-05", work: "mail tracker " + variant + " " + month + " " + rows.length + " rows" });
    return { status: 200, body: { fileName: "tracker-" + variant + "-" + month + ".csv", csv } };
  }
  return { status: 200, body: { variant, month, label: VARIANTS[variant].label, manual: !!VARIANTS[variant].fields, fields: VARIANTS[variant].fields || [], rows } };
}

async function postMailTrackerByVariant(ctx) {
  const variant = ctx.params.variant;
  if (!VARIANTS[variant] || !VARIANTS[variant].fields) return { status: 404, body: { error: "this tracker fills itself from mail and tickets" } };
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk only" } };
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(ctx.body.month)) ? String(ctx.body.month) : istToday().slice(0, 7);
  const t = await trackerInput(ctx, variant, ctx.body, null);
  if (t.errors.length) return { status: 400, body: { error: t.errors.join("; ") } };
  const file = await trackerFile(ctx.body.file);
  if (file && file.error) return { status: 400, body: { error: file.error } };
  const companyId = oid(ctx.user.companyId);
  const doc = { companyId, variant, month, ...t.out, createdBy: ctx.user._id, createdAt: new Date(), updatedAt: new Date() };
  const r = await repo.tracker_rows.insert(doc);
  if (file) {
    await repo.documents.insert({ companyId, parentType: "trackerRow", parentId: r.insertedId, type: VARIANTS[variant].label, version: 1, ...file, franchiseId: doc.franchiseId, uploadedBy: ctx.user._id, uploadedAt: new Date() });
  }
  await writeAudit(ctx, "TrackerRowSaved", { companyId, module: "CRM-05", recordId: r.insertedId, after: doc, work: variant + " " + (doc.atmId || "") });
  return { status: 200, body: { id: String(r.insertedId) } };
}

async function patchMailTrackerRowById(ctx) {
  if (!isDesk(ctx.user)) return { status: 403, body: { error: "service desk only" } };
  const row = await repo.tracker_rows.findById(oid(ctx.params.id));
  if (!row || String(row.companyId) !== String(ctx.user.companyId)) return { status: 404, body: { error: "not found" } };
  const t = await trackerInput(ctx, row.variant, ctx.body, row);
  if (t.errors.length) return { status: 400, body: { error: t.errors.join("; ") } };
  const file = await trackerFile(ctx.body.file);
  if (file && file.error) return { status: 400, body: { error: file.error } };
  const set = { ...t.out, updatedAt: new Date() };
  await repo.tracker_rows.updateById(row._id, { $set: set });
  if (file) {
    const version = await nextVersion(row.companyId, row._id, VARIANTS[row.variant].label);
    await repo.documents.insert({ companyId: row.companyId, parentType: "trackerRow", parentId: row._id, type: VARIANTS[row.variant].label, version, ...file, franchiseId: set.franchiseId !== undefined ? set.franchiseId : row.franchiseId, uploadedBy: ctx.user._id, uploadedAt: new Date() });
  }
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "TrackerRowSaved", { companyId: row.companyId, module: "CRM-05", recordId: row._id, before, after: set, work: row.variant });
  return { status: 200, body: { ok: true } };
}

module.exports = { deliver, addresses, render, ticketVars, templates, signature, sameCompany, loadTicket, publicMail, trackerFile, saveAttachment, trySend, queueAutoMail, drainQueue, queueMailWithFile, receiveInbound, franchiseEmail, mapInbound, recordReply, pvcStatus, trackerRows, nextMonth, trackerInput, getMailMeta, postMailMailbox, putMailTemplatesByKey, putMailSignature, postMailRender, getMail, postMail, patchMailById, postMailInbound, patchMailByIdMap, postMailByIdTicket, postMailByIdReply, getMailTrackerByVariant, postMailTrackerByVariant, patchMailTrackerRowById };
