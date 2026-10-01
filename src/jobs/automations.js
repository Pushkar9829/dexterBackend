const { notify, notifyFranchise, franchiseUsers, officeDesk, companyAdmins } = require("../modules/notices/notices.service");
const { lifecycle } = require("../modules/agreements/agreements.model");
const { canApproveApplication } = require("../middlewares/rbac");
const { writeAudit } = require("../utils/audit-writer");
const { istToday, shiftDate } = require("../utils/dates");
const repo = require("../utils/shared.repository");

const SYSTEM_REQ = { user: { login: "system" }, headers: {}, ip: "" };
const daysSince = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

// Current stage past its due date: tell project owner, desk and franchise once a week; from 7 days late Admins too.
async function sweepProjectDelays(companyId) {
  const today = istToday();
  let sent = 0;
  const desk = await officeDesk(companyId);
  const projects = await repo.collection("site_projects").list({ companyId, completedAt: null, held: { $ne: true } }, { projection: { stages: 1, createdBy: 1, franchiseId: 1, projectName: 1, siteLocationName: 1, siteNumber: 1 } });
  for (const p of projects) {
    const idx = (p.stages || []).findIndex((s) => !s.approvedAt);
    if (idx < 0) continue;
    const s = p.stages[idx];
    if (!s.dueDate || s.dueDate >= today) continue;
    const late = daysSince(s.dueDate, today);
    const week = Math.floor(late / 7);
    const name = p.projectName || p.siteLocationName || p.siteNumber || "Project";
    const n = { kind: "stage", title: "Project delayed: " + name, body: s.name + " was due " + s.dueDate + " (" + late + " day" + (late > 1 ? "s" : "") + " late)", link: { page: "projects", id: String(p._id) }, key: "proj-delay:" + p._id + ":" + idx + ":" + week };
    sent += await notify(companyId, [p.createdBy, ...desk, ...(late >= 7 ? await companyAdmins(companyId) : [])], n);
    sent += await notifyFranchise(companyId, p.franchiseId, n);
  }
  return sent;
}

// One renewal task per agreement when it reaches Renewal Due (or has expired without a successor).
async function sweepAgreementRenewals(companyId) {
  const { createTask } = require("../modules/tasks/tasks.service");
  const today = istToday();
  const lu = (await repo.collection("lookups").findOne({ companyId })) || {};
  const renewDays = Number(lu.agreementRenewalDays) > 0 ? Number(lu.agreementRenewalDays) : 60;
  const all = await repo.collection("agreements").list({ companyId }, { projection: { status: 1, applicationId: 1, createdAt: 1, endDate: 1, renewalDate: 1, franchiseId: 1, createdBy: 1, renewalTaskId: 1, agreementNo: 1 } });
  let created = 0;
  for (const g of all) {
    if (g.renewalTaskId) continue;
    const life = lifecycle(g, all, today, renewDays);
    if (!["Renewal Due", "Expired"].includes(life)) continue;
    const app = g.applicationId ? await repo.collection("applications").findOne({ _id: g.applicationId }, { projection: { siteLocationName: 1 } }) : null;
    const site = (app && app.siteLocationName) || "site";
    const endAt = new Date(g.endDate + "T18:00:00+05:30");
    const dueAt = endAt > new Date() ? endAt : new Date(Date.now() + 3 * 86400000);
    const body = { title: "Renew agreement" + (g.agreementNo ? " " + g.agreementNo : "") + ": " + site, description: "Agreement " + (life === "Expired" ? "expired on " : "ends on ") + g.endDate + ". Prepare the renewal and share it for signing.", source: "Agreement", type: "Document", subType: "Agreement", category: "Office", priority: life === "Expired" ? "Critical" : "High", franchiseId: g.franchiseId ? String(g.franchiseId) : undefined, dueAt: dueAt.toISOString() };
    const actor = { _id: g.createdBy || null, name: "Agreement renewal" };
    let r = g.createdBy ? await createTask(companyId, actor, { ...body, assigneeId: String(g.createdBy) }, { allowPastDue: true }) : { error: "no creator" };
    if (r.error) r = await createTask(companyId, actor, body, { allowPastDue: true });
    if (!r.task) continue;
    await repo.collection("agreements").updateById(g._id, { $set: { renewalTaskId: r.task._id, renewalTaskNo: r.task.taskNo } });
    if (!r.task.assigneeId) await notify(companyId, await companyAdmins(companyId), { kind: "legal", title: "Renewal task unassigned: " + r.task.taskNo, body: site, link: { page: "tasks", id: String(r.task._id) } });
    await writeAudit(SYSTEM_REQ, "TaskCreated", { companyId, module: "CRM-06", recordId: r.task._id, work: r.task.taskNo + " from agreement renewal " + (g.agreementNo || String(g._id)) });
    created++;
  }
  return created;
}

// Pending KYC (verifiers, daily digest), rejected KYC awaiting re-upload (franchise, every 3 days), expiring KYC (franchise + desk).
async function sweepKycReminders(companyId) {
  const today = istToday();
  const out = { pending: 0, resubmit: 0, expiring: 0 };
  const docs = await repo.collection("documents").list({ companyId, $or: [{ parentType: "application" }, { parentType: { $exists: false } }] }, { projection: { data: 0 } });
  const latest = new Map();
  for (const d of docs) {
    const k = String(d.parentId) + "|" + d.type;
    if (!latest.has(k) || (latest.get(k).version || 0) < (d.version || 0)) latest.set(k, d);
  }
  const top = [...latest.values()];
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const stale = top.filter((d) => (d.verificationStatus || "Under Verification") === "Under Verification" && d.uploadedAt && new Date(d.uploadedAt) < cutoff);
  if (stale.length) {
    const verifiers = (await repo.users.list({ companyId, active: true })).filter((u) => canApproveApplication(u)).map((u) => u._id);
    out.pending += await notify(companyId, verifiers, { kind: "kyc", title: stale.length + " KYC document" + (stale.length > 1 ? "s" : "") + " waiting over 48 h", body: [...new Set(stale.map((d) => d.type))].slice(0, 8).join(", "), link: { page: "kyc" }, key: "kyc-pending:" + today });
  }
  const apps = new Map((await repo.collection("applications").list({ companyId }, { projection: { createdBy: 1, franchiseId: 1, siteLocationName: 1 } })).map((a) => [String(a._id), a]));
  for (const d of top.filter((x) => x.verificationStatus === "KYC Rejected" && x.verifiedAt)) {
    const days = daysSince(new Date(d.verifiedAt).toISOString().slice(0, 10), today);
    if (days < 1) continue;
    const a = apps.get(String(d.parentId)) || {};
    out.resubmit += await notify(companyId, [a.createdBy, ...(await franchiseUsers(companyId, d.franchiseId || a.franchiseId))], { kind: "kyc", title: "Re-upload KYC: " + d.type, body: (a.siteLocationName || "") + (d.rejectionReason ? " · " + d.rejectionReason : ""), link: { page: "kyc", id: String(d._id) }, key: "kyc-resubmit:" + d._id + ":" + Math.floor(days / 3) });
  }
  const desk = await officeDesk(companyId);
  const soon = shiftDate(today, 30);
  for (const d of top.filter((x) => x.expiry && x.expiry <= soon && x.verificationStatus !== "KYC Rejected")) {
    const expired = d.expiry < today;
    const a = apps.get(String(d.parentId)) || {};
    out.expiring += await notify(companyId, [...desk, a.createdBy, ...(await franchiseUsers(companyId, d.franchiseId || a.franchiseId))], { kind: "kyc", title: (expired ? "KYC expired: " : "KYC expiring: ") + d.type, body: (a.siteLocationName || "") + " · " + d.expiry, link: { page: "kyc", id: String(d._id) }, key: "kyc-expiry:" + d._id + ":" + (expired ? "x" : "30") });
  }
  return out;
}

async function sweepAutomations(companyId) {
  return {
    projectDelays: await sweepProjectDelays(companyId),
    renewalTasks: await sweepAgreementRenewals(companyId),
    kyc: await sweepKycReminders(companyId),
  };
}

module.exports = { sweepProjectDelays, sweepAgreementRenewals, sweepKycReminders, sweepAutomations };
