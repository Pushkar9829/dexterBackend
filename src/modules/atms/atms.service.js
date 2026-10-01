const { companyScope, canCreateAtm } = require("../../middlewares/rbac");
const { FUNDING_PATHS, ATM_TEXT_FIELDS, ATM_STATUSES, atmStatus } = require("./atms.model");
const repo = require("./atms.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, atmInProject, byProject } = require("../../utils/scope");

async function getAtms(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  if (ctx.user.hierarchy === "Franchise") {
    filter.$or = [
      { ownerUserId: ctx.user._id },
      ...(filter.franchiseId ? [{ franchiseId: filter.franchiseId }] : []),
    ];
    delete filter.franchiseId;
  }
  const list = await repo.atms.list(filter, { sort: { atmId: 1 }, limit: 500 });
  await linkLegal(companyId, list);
  list.forEach((a) => (a.status = atmStatus(a)));
  return { status: 200, body: { atms: list, statuses: ATM_STATUSES } };
}

async function linkLegal(companyId, atms) {
  if (!atms.length) return;
  const projects = await repo.site_projects.list({ companyId, atmId: { $in: atms.map((a) => a.atmId) } }, { projection: { atmId: 1, applicationId: 1 } });
  const siteIds = atms.map((a) => a.siteId).filter(Boolean);
  const apps = siteIds.length ? await repo.applications.list({ companyId, siteId: { $in: siteIds } }, { projection: { siteId: 1 } }) : [];
  const appOf = new Map();
  apps.forEach((a) => appOf.set("site:" + a.siteId, String(a._id)));
  projects.forEach((p) => p.applicationId && appOf.set("atm:" + p.atmId, String(p.applicationId)));
  const appIds = [...new Set([...appOf.values()])].map(oid);
  const [lois, agrs] = appIds.length
    ? await Promise.all([repo.lois.list({ companyId, applicationId: { $in: appIds } }, { sort: { createdAt: -1 } }), repo.agreements.list({ companyId, applicationId: { $in: appIds } }, { sort: { createdAt: -1 } })])
    : [[], []];
  for (const a of atms) {
    const appId = appOf.get("atm:" + a.atmId) || appOf.get("site:" + a.siteId);
    const loi = appId && lois.find((l) => String(l.applicationId) === appId);
    const agr = appId && agrs.find((g) => String(g.applicationId) === appId);
    a.loiRegister = loi ? loi.loiCode + " (" + loi.status + ")" : "";
    a.agreementRegister = agr ? agr.status + (agr.agreementType ? " · " + agr.agreementType : "") : "";
  }
}

async function postAtms(ctx) {
  if (!canCreateAtm(ctx.user)) return { status: 403, body: { error: "ATM master create is Admin / Ops only" } };
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const atmId = String(ctx.body.atmId || "").trim();
  const serial = String(ctx.body.atmSerialNumber || "").trim();
  const machineType = String(ctx.body.machineTypeModel || "").trim();
  if (!atmId || !serial || !machineType) {
    return { status: 400, body: { error: "atmId, atmSerialNumber, machineTypeModel required" } };
  }
  const dup = await repo.atms.findOne({ companyId, atmId });
  if (dup) return { status: 409, body: { error: "ATM ID exists in this company" } };
  let projectId = null;
  if (ctx.body.projectId) {
    const p = await repo.projects.findOne({ _id: oid(ctx.body.projectId), companyId });
    if (!p) return { status: 400, body: { error: "project not in this company" } };
    projectId = p._id;
  }
  if (ctx.body.franchiseId && !(await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId }))) {
    return { status: 400, body: { error: "franchise not in this company" } };
  }
  const siteErr = await siteProblem(companyId, ctx.body.siteId);
  if (siteErr) return { status: 400, body: { error: siteErr } };
  if (ctx.body.status && !ATM_STATUSES.includes(ctx.body.status)) return { status: 400, body: { error: "status must be " + ATM_STATUSES.join(" / ") } };
  const doc = {
    companyId,
    atmId,
    region: String(ctx.body.region || "").trim(),
    atmSerialNumber: serial,
    machineTypeModel: machineType,
    model: String(ctx.body.model || ""),
    modelType: String(ctx.body.modelType || ""),
    atmType: String(ctx.body.atmType || ""),
    city: String(ctx.body.city || ""),
    state: String(ctx.body.state || "").trim(),
    hitachiCode: String(ctx.body.hitachiCode || "").trim(),
    sapCode: String(ctx.body.sapCode || "").trim(),
    solId: String(ctx.body.solId || "").trim(),
    status: ctx.body.status || "Under Installation",
    siteId: String(ctx.body.siteId || ""),
    franchiseeName: String(ctx.body.franchiseeName || ""),
    mobile: String(ctx.body.mobile || ""),
    email: String(ctx.body.email || ""),
    bankName: String(ctx.body.bankName || ""),
    loi: String(ctx.body.loi || ""),
    agreement: String(ctx.body.agreement || ""),
    mdType: String(ctx.body.mdType || "").trim(),
    fundingPath: FUNDING_PATHS.includes(ctx.body.fundingPath) ? ctx.body.fundingPath : "",
    email2: String(ctx.body.email2 || "").trim(),
    salesOfficer: String(ctx.body.salesOfficer || "").trim(),
    franchiseId: ctx.body.franchiseId ? oid(ctx.body.franchiseId) : null,
    projectId,
    cashLiveDate: null,
    ownerUserId: ctx.body.ownerUserId ? oid(ctx.body.ownerUserId) : null,
    createdAt: new Date(),
  };
  const result = await repo.atms.insert(doc);
  await writeAudit(ctx, "ATMCreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

require("../imports/imports.registry").registerImporter("ATM-master", {
  headers: ["atmId", "atmSerialNumber", "machineTypeModel", "model", "modelType", "atmType", "siteId", "franchise", "franchiseeName", "mobile", "email", "email2", "mdType", "bankName", "fundingPath", "loi", "agreement", "city", "state", "region", "salesOfficer", "hitachiCode", "sapCode", "solId", "status"],
  required: ["atmId", "atmSerialNumber", "machineTypeModel"],
  canImport: (u) => canCreateAtm(u),
  denied: "ATM master import is Admin / Ops only",
  event: "ATMMasterImported",
  module: "CRM-02",
  rule: "new ATM IDs are added; an existing ATM ID has its text columns updated (Cash Live date is never imported)",
  async save(ctx, input, batchId) {
    const atmId = String(input.atmId || "").trim();
    const errors = [];
    if (input.fundingPath && !FUNDING_PATHS.includes(input.fundingPath)) errors.push({ column: "fundingPath", reason: "funding path must be " + FUNDING_PATHS.join(" / ") });
    const status = String(input.status || "").trim();
    if (status && !ATM_STATUSES.includes(status)) errors.push({ column: "status", reason: "status must be " + ATM_STATUSES.join(" / ") });
    const siteErr = await siteProblem(ctx.companyId, input.siteId);
    if (siteErr) errors.push({ column: "siteId", reason: siteErr });
    let franchiseId;
    if (String(input.franchise || "").trim()) {
      const fr = await repo.franchises.findOne({ companyId: ctx.companyId, name: String(input.franchise).trim() });
      if (!fr) errors.push({ column: "franchise", reason: "franchise not found: " + input.franchise });
      else franchiseId = fr._id;
    }
    if (errors.length) return { errors };
    const set = {};
    ATM_TEXT_FIELDS.forEach((k) => input[k] !== undefined && String(input[k]).trim() !== "" && (set[k] = String(input[k]).trim()));
    if (input.fundingPath) set.fundingPath = input.fundingPath;
    if (status) set.status = status;
    if (franchiseId) set.franchiseId = franchiseId;
    const existing = await repo.atms.findOne({ companyId: ctx.companyId, atmId });
    if (existing) await repo.atms.updateById(existing._id, { $set: { ...set, importBatchId: batchId, updatedAt: new Date() } });
    else await repo.atms.insert({ companyId: ctx.companyId, atmId, status: "Under Installation", ...set, projectId: null, cashLiveDate: null, ownerUserId: null, importBatchId: batchId, createdAt: new Date() });
    return { ok: true, key: atmId + (existing ? " (updated)" : " (new)") };
  },
});

async function siteProblem(companyId, siteId) {
  const id = String(siteId || "").trim();
  if (!id) return "";
  return (await repo.sites.findOne({ companyId, siteId: id })) ? "" : "Site ID " + id + " is not in the Site master";
}

async function patchAtmsById(ctx) {
  if (!canCreateAtm(ctx.user)) return { status: 403, body: { error: "ATM master edit is Admin / Ops only" } };
  const row = await repo.atms.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId) || !atmInProject(ctx.user, row)) return { status: 404, body: { error: "not found" } };
  const set = {};
  ATM_TEXT_FIELDS.forEach((k) => {
    if (ctx.body[k] !== undefined) set[k] = String(ctx.body[k]).trim();
  });
  if (ctx.body.fundingPath !== undefined) {
    if (ctx.body.fundingPath && !FUNDING_PATHS.includes(ctx.body.fundingPath)) return { status: 400, body: { error: "funding path must be WLA, Axis or ICD" } };
    set.fundingPath = ctx.body.fundingPath || "";
  }
  if (ctx.body.status !== undefined && ctx.body.status !== atmStatus(row)) {
    if (!ATM_STATUSES.includes(ctx.body.status)) return { status: 400, body: { error: "status must be " + ATM_STATUSES.join(" / ") } };
    const reason = String(ctx.body.statusReason || "").trim();
    if (["Inactive", "Temporarily Down", "Suspended", "Decommissioned"].includes(ctx.body.status) && !reason) return { status: 400, body: { error: "give a reason for " + ctx.body.status } };
    set.status = ctx.body.status;
    set.statusReason = reason;
    set.statusAt = new Date();
  }
  if ((set.atmSerialNumber !== undefined && !set.atmSerialNumber) || (set.machineTypeModel !== undefined && !set.machineTypeModel)) {
    return { status: 400, body: { error: "ATM serial number and machine type/model cannot be empty" } };
  }
  if (set.siteId && set.siteId !== row.siteId) {
    const siteErr = await siteProblem(row.companyId, set.siteId);
    if (siteErr) return { status: 400, body: { error: siteErr } };
  }
  if (ctx.body.franchiseId !== undefined) {
    if (!ctx.body.franchiseId) set.franchiseId = null;
    else {
      const node = await repo.franchises.findOne({ _id: oid(ctx.body.franchiseId), companyId: row.companyId });
      if (!node) return { status: 400, body: { error: "franchise not in this company" } };
      set.franchiseId = node._id;
    }
  }
  if (ctx.body.projectId !== undefined) {
    if (!ctx.body.projectId) {
      if (byProject(ctx.user)) return { status: 400, body: { error: "pick one of your projects" } };
      set.projectId = null;
    } else {
      const p = await repo.projects.findOne({ _id: oid(ctx.body.projectId), companyId: row.companyId });
      if (!p) return { status: 400, body: { error: "project not in this company" } };
      if (byProject(ctx.user) && !ctx.user.projectIds.some((x) => String(x) === String(p._id))) return { status: 403, body: { error: "outside your projects" } };
      set.projectId = p._id;
    }
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  set.updatedAt = new Date();
  await repo.atms.updateById(row._id, { $set: set });
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, "ATMUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before, after: set });
  return { status: 200, body: { ok: true } };
}

module.exports = { linkLegal, siteProblem, getAtms, postAtms, patchAtmsById };
