const { companyScope, isOfficeAdmin } = require("../../middlewares/rbac");
const repo = require("./agreements.repository");
const { LIFECYCLES, TERM_TEXT, lifecycle } = require("./agreements.model");
const { istToday } = require("../../utils/dates");
const { legalCreateGuard, checkExtra, legalPatchGuard, legalTarget } = require("../legal/legal.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, applyRecordProject, FRANCHISE_LAYERS } = require("../../utils/scope");

async function getAgreements(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  applyRecordProject(ctx.user, filter);
  const list = await repo.agreements.list(filter, { sort: { createdAt: -1 } });
  const columns = await repo.register_columns.list({ companyId, register: "agreement" });
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const renewDays = Number(lu.agreementRenewalDays) > 0 ? Number(lu.agreementRenewalDays) : 60;
  const today = istToday();
  list.forEach((g) => (g.lifecycle = lifecycle(g, list, today, renewDays)));
  return { status: 200, body: { agreements: list, columns, lifecycles: LIFECYCLES } };
}

async function postAgreements(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const g = await legalCreateGuard(ctx, companyId);
  if (g.error) return { status: 403, body: { error: g.error } };
  if (ctx.body.extra && FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return { status: 403, body: { error: "extra columns are office-only" } };
  const x = await checkExtra(companyId, "agreement", ctx.body.extra, {});
  if (x.error) return { status: 400, body: { error: x.error } };
  const doc = {
    companyId,
    applicationId: g.appId,
    franchiseId: g.franchiseId,
    projectId: g.projectId,
    siteId: ctx.body.siteId ? oid(ctx.body.siteId) : null,
    status: "Pending",
    extra: x.extra,
    createdAt: new Date(),
  };
  const result = await repo.agreements.insert(doc);
  await writeAudit(ctx, "AgreementCreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchAgreementsById(ctx) {
  const row = await repo.agreements.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const denied = await legalPatchGuard(ctx, row);
  if (denied) return { status: 403, body: { error: denied } };
  const t = await legalTarget(ctx, row, "agreement");
  if (t.error) return { status: 400, body: { error: t.error } };
  const set = { updatedAt: new Date() };
  if (t.status) set.status = t.status;
  if (ctx.body.extra) {
    const x = await checkExtra(row.companyId, "agreement", ctx.body.extra, row.extra, { parentId: row._id, userId: ctx.user._id, franchiseId: row.franchiseId });
    if (x.error) return { status: 400, body: { error: x.error } };
    set.extra = x.extra;
  }
  if (ctx.body.agreementType !== undefined && isOfficeAdmin(ctx.user)) {
    const lk = await repo.lookups.findOne({ companyId: row.companyId });
    const type = String(ctx.body.agreementType || "").trim();
    if (type && !((lk && lk.agreementTypes) || []).includes(type)) return { status: 400, body: { error: "agreement type not in the lookup list" } };
    set.agreementType = type;
  }
  const termKeys = ["signedDate", "startDate", "endDate", "renewalDate"].filter((k) => ctx.body[k] !== undefined);
  if (termKeys.length) {
    if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return { status: 403, body: { error: "agreement dates are office-only" } };
    for (const k of termKeys) {
      const v = String(ctx.body[k] || "").trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { status: 400, body: { error: k + " must be a date YYYY-MM-DD" } };
      set[k] = v;
    }
    const d = { ...row, ...set };
    if (d.startDate && d.endDate && d.endDate < d.startDate) return { status: 400, body: { error: "end date is before the start date" } };
    if (d.renewalDate && d.endDate && d.renewalDate > d.endDate) return { status: 400, body: { error: "renewal date is after the end date" } };
  }
  const textKeys = TERM_TEXT.filter((k) => ctx.body[k] !== undefined);
  if (textKeys.length || ctx.body.noticePeriodDays !== undefined) {
    if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) return { status: 403, body: { error: "agreement terms are office-only" } };
    for (const k of textKeys) set[k] = String(ctx.body[k] || "").trim().slice(0, 2000);
    if (set.agreementNo && (await repo.agreements.findOne({ companyId: row.companyId, agreementNo: set.agreementNo, _id: { $ne: row._id } }))) return { status: 409, body: { error: "agreement number " + set.agreementNo + " is already used" } };
    if (ctx.body.noticePeriodDays !== undefined) {
      const n = ctx.body.noticePeriodDays === "" || ctx.body.noticePeriodDays === null ? null : Number(ctx.body.noticePeriodDays);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 365)) return { status: 400, body: { error: "notice period must be 0–365 days" } };
      set.noticePeriodDays = n;
    }
  }
  if (set.status === "Approved" && !(set.agreementNo || row.agreementNo)) return { status: 400, body: { error: "enter the agreement number before approving" } };
  if (set.status === "Approved" && !(set.endDate || row.endDate)) return { status: 400, body: { error: "set the agreement start and end dates before approving" } };
  if (ctx.body.link !== undefined) {
    const link = String(ctx.body.link || "").trim();
    if (link && !/^https?:\/\/\S+$/i.test(link)) return { status: 400, body: { error: "link must start with http:// or https://" } };
    set.link = link;
  }
  if (set.status === "Terminated") {
    set.terminatedAt = new Date();
    set.terminatedBy = ctx.user._id;
    set.terminationReason = String(ctx.body.reason || "").trim();
  }
  await repo.agreements.updateById(row._id, { $set: set });
  await writeAudit(ctx, set.status === "Link Shared" ? "LinkShared" : set.status === "Terminated" ? "AgreementTerminated" : "AgreementStatusChanged", {
    companyId: row.companyId,
    module: "CRM-02",
    recordId: row._id,
    before: { status: row.status, link: row.link || "", agreementType: row.agreementType || "", signedDate: row.signedDate || "", startDate: row.startDate || "", endDate: row.endDate || "", renewalDate: row.renewalDate || "", agreementNo: row.agreementNo || "", noticePeriodDays: row.noticePeriodDays ?? null, paymentTerms: row.paymentTerms || "", payoutTerms: row.payoutTerms || "", penaltyClause: row.penaltyClause || "", extra: row.extra || null },
    after: set,
    work: t.override ? "Admin override: " + String(ctx.body.reason) : "",
  });
  if (set.status === "Link Shared") {
    const notify = require("../notices/notices.service").notifyFranchise;
    if (notify) await notify(row.companyId, row.franchiseId, { kind: "legal", title: "Agreement link shared", body: set.link || row.link || "Open Legal → Agreements", key: "link-shared:" + row._id + ":" + Date.now() }).catch(() => {});
    const fr = row.franchiseId ? await repo.franchises.findById(row.franchiseId) : null;
    const to = await require("../mail/mail.service").franchiseEmail(row.companyId, row.franchiseId, null);
    if (to.length) await require("../mail/mail.service").queueAutoMail(row.companyId, { templateKey: "link-shared", vars: { franchise: fr ? fr.name : "", link: set.link || row.link || "" }, to, franchiseId: row.franchiseId });
  }
  if (set.status === "Terminated") {
    await require("../notices/notices.service").notifyFranchise(row.companyId, row.franchiseId, { kind: "legal", title: "Agreement terminated", body: set.terminationReason, link: { page: "legal", id: String(row._id) }, key: "agreement-terminated:" + row._id }).catch(() => {});
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { getAgreements, postAgreements, patchAgreementsById };
