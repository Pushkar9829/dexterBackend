const { companyScope, isOfficeStaff, can, canApproveApplication, canSetLinkShared } = require("../../middlewares/rbac");
const { APP_FIELDS, DOC_CHECKLIST, ATM_GRID_COLS, SUBMIT_REQUIRED, SUBMIT_DOCS, FORMAT_RULES } = require("./applications.model");
const repo = require("./applications.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");
const { recordInProject, FRANCHISE_LAYERS, inRecordScope, inFranchiseScope, applyFranchiseFilter, applyRecordProject, applyRecordScope, defaultProjectId } = require("../../utils/scope");

async function getApplications(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  if (ctx.user.hierarchy === "Franchise" && filter.franchiseId && filter.franchiseId.$in && !filter.franchiseId.$in.length) {
    filter.createdBy = ctx.user._id;
    delete filter.franchiseId;
  }
  applyRecordProject(ctx.user, filter);
  await applyRecordScope(ctx.user, filter, ["createdBy", "ownerUserId"]);
  const list = await repo.applications.list(filter, { sort: { createdAt: -1 }, limit: 200 });
  return { status: 200, body: { applications: list } };
}

async function postApplications(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const extra = pickApp(ctx.body);
  const bad = formatProblems(extra);
  if (bad.length) return { status: 400, body: { error: bad.join("; "), problems: bad } };
  if (extra.franchiseId) extra.franchiseId = oid(extra.franchiseId);
  if (!isOfficeStaff(ctx.user)) {
    delete extra.siteNumber;
    delete extra.sourcedBy;
    delete extra.sourcingCode;
    delete extra.sseSsm;
  }
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) {
    if (!extra.franchiseId || !(await inFranchiseScope(ctx.user, extra.franchiseId))) {
      extra.franchiseId = ctx.user.franchiseId || null;
    }
  } else if (extra.franchiseId) {
    const node = await repo.franchises.findOne({ _id: extra.franchiseId, companyId });
    if (!node) return { status: 400, body: { error: "franchise not in this company" } };
  }
  const proj = await defaultProjectId(ctx.user, companyId, ctx.body.projectId);
  if (proj.error) return { status: 400, body: { error: proj.error } };
  const doc = {
    companyId,
    projectId: proj.projectId,
    status: "Under Process",
    projectType: extra.projectType || "WLA Franchise Model",
    agreementStatus: "Pending",
    createdBy: ctx.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
    franchiseId: extra.franchiseId || ctx.user.franchiseId || null,
  };
  const result = await repo.applications.insert(doc);
  await writeAudit(ctx, "ApplicationSaved", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchApplicationsById(ctx) {
  const id = oid(ctx.params.id);
  if (!id) return { status: 400, body: { error: "bad id" } };
  const row = await repo.applications.findById(id);
  if (!row) return { status: 404, body: { error: "not found" } };
  if (!companyScope(ctx.user, row.companyId)) return { status: 403, body: { error: "company scope" } };
  if (!(await canTouchApplication(ctx.user, row))) {
    return { status: 403, body: { error: "own records only" } };
  }

  const lockedForEntry = !["Under Process", "Draft", "Resubmission"].includes(row.status);
  const isAdminOverride = ctx.user.hierarchy === "Admin" || ctx.user.hierarchy === "DexterIndiaCompanyTeam";
  if (ctx.body.approve || ctx.body.reject || ctx.body.sendBack) {
    if (row.status === "Approved" || row.status === "Rejected") {
      if (!isAdminOverride) return { status: 403, body: { error: "already decided; Admin override only" } };
      if (row.status === "Approved" && !ctx.body.approve && (await repo.site_projects.findOne({ companyId: row.companyId, applicationId: row._id }))) {
        return { status: 400, body: { error: "a project has started for this site; hold the project instead of reversing approval" } };
      }
    } else if (row.status !== "Submitted") {
      return { status: 400, body: { error: "only a submitted application can be approved or rejected" } };
    }
  }
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy) && ctx.body.franchiseId !== undefined) {
    if (!(await inFranchiseScope(ctx.user, ctx.body.franchiseId))) delete ctx.body.franchiseId;
  }

  const officeFieldsBySubmittedDecider = ctx.body.siteNumber !== undefined && row.status === "Submitted" && canApproveApplication(ctx.user);
  if (ctx.body.submit) {
    if (!["Under Process", "Draft", "Resubmission"].includes(row.status)) return { status: 400, body: { error: "already submitted" } };
    if (!can(ctx.user, "Create", "CRM-02") && !can(ctx.user, "Edit", "CRM-02")) {
      return { status: 403, body: { error: "not allowed" } };
    }
    const missing = await submitProblems({ ...row, ...pickApp(ctx.body) });
    if (missing.length) return { status: 400, body: { error: "Complete before submitting: " + missing.join("; "), problems: missing } };
  } else if (ctx.body.approve || ctx.body.reject || ctx.body.sendBack) {
    if (!canApproveApplication(ctx.user)) return { status: 403, body: { error: "not allowed" } };
    if (ctx.body.approve && !String(ctx.body.siteNumber || row.siteNumber || "").trim()) return { status: 400, body: { error: "set the Site Number (office use) before approving" } };
    if ((ctx.body.reject || ctx.body.sendBack) && !String(ctx.body.reason || "").trim()) return { status: 400, body: { error: "a reason is required" } };
  } else if (officeFieldsBySubmittedDecider) {
    if (!can(ctx.user, "Edit", "CRM-02") && !isAdminOverride) return { status: 403, body: { error: "not allowed" } };
  } else if (ctx.body.agreementStatus === "Link Shared") {
    if (!canSetLinkShared(ctx.user)) return { status: 403, body: { error: "only Admin or Sales Officer can set Link Shared" } };
  } else if (lockedForEntry && !isAdminOverride) {
    return { status: 403, body: { error: "entry locked after submit; Admin override only" } };
  } else if (!can(ctx.user, "Edit", "CRM-02") && !isAdminOverride) {
    return { status: 403, body: { error: "not allowed" } };
  }

  const before = { status: row.status, agreementStatus: row.agreementStatus };
  const set = { updatedAt: new Date() };
  if (!lockedForEntry || isAdminOverride) {
    const bad = formatProblems(pickApp(ctx.body));
    if (bad.length) return { status: 400, body: { error: bad.join("; "), problems: bad } };
    Object.assign(set, pickApp(ctx.body));
    if (!isOfficeStaff(ctx.user)) ["siteNumber", "sourcedBy", "sourcingCode", "sseSsm"].forEach((k) => delete set[k]);
    if (set.franchiseId) {
      const node = await repo.franchises.findOne({ _id: oid(set.franchiseId), companyId: row.companyId });
      if (!node) return { status: 400, body: { error: "franchise not in this company" } };
      set.franchiseId = node._id;
    }
  }
  if (ctx.body.siteNumber !== undefined && (isAdminOverride || officeFieldsBySubmittedDecider)) {
    set.siteNumber = String(ctx.body.siteNumber || "").trim();
    ["sourcedBy", "sourcingCode", "sseSsm"].forEach((k) => ctx.body[k] !== undefined && (set[k] = String(ctx.body[k] || "").trim()));
  }
  if (ctx.body.agreementStatus !== undefined && (canSetLinkShared(ctx.user) || isAdminOverride)) {
    const AGR = ["Pending", "Uploaded", "Link Shared", "Under Review", "Approved", "Rejected", "Resubmission Required"];
    if (!AGR.includes(ctx.body.agreementStatus)) return { status: 400, body: { error: "agreement status must be one of " + AGR.join(", ") } };
    if (["Approved", "Rejected"].includes(row.agreementStatus) && row.agreementStatus !== ctx.body.agreementStatus && !isAdminOverride) {
      return { status: 400, body: { error: "agreement already " + row.agreementStatus + "; Admin override only" } };
    }
    set.agreementStatus = ctx.body.agreementStatus;
  }
  if (ctx.body.submit) {
    set.status = "Submitted";
    set.submittedAt = new Date();
    set.submittedBy = ctx.user._id;
  }
  if (ctx.body.approve || ctx.body.reject) {
    set.status = ctx.body.approve ? "Approved" : "Rejected";
    set.decidedAt = new Date();
    set.decidedBy = ctx.user._id;
    set.decisionReason = String(ctx.body.reason || "").trim();
  }
  if (ctx.body.sendBack) {
    set.status = "Resubmission";
    set.sendBackReason = String(ctx.body.reason || "");
  }
  const guard = { _id: id, status: row.status };
  if (set.agreementStatus !== undefined) guard.agreementStatus = row.agreementStatus === undefined ? null : row.agreementStatus;
  const moved = await repo.applications.updateOne(guard, { $set: set });
  if (!moved.matchedCount) return { status: 409, body: { error: "application changed meanwhile; reload" } };
  const work = ctx.body.submit
    ? "submit"
    : ctx.body.approve
      ? "approve"
      : ctx.body.reject
        ? "reject"
        : ctx.body.sendBack
          ? "send back for resubmission"
        : ctx.body.siteNumber !== undefined
          ? "site number"
          : ctx.body.agreementStatus === "Link Shared"
            ? "Link Shared"
            : "edit";
  const eventName = ctx.body.submit
    ? "ApplicationSubmitted"
    : ctx.body.approve
      ? "ApplicationApproved"
      : ctx.body.reject
        ? "ApplicationRejected"
        : ctx.body.sendBack
          ? "ApplicationSentBack"
          : ctx.body.siteNumber !== undefined
          ? "SiteNumberSet"
          : "ApplicationUpdated";
  await writeAudit(ctx, eventName, {
    companyId: row.companyId,
    module: "CRM-02",
    recordId: id,
    before,
    after: set,
    work,
  });
  if (set.status && set.status !== row.status) await notifyStatus(row, set.status, set.decisionReason || set.sendBackReason || "").catch(() => null);
  return { status: 200, body: { ok: true } };
}

function formatProblems(fields) {
  return FORMAT_RULES.filter(([k, re]) => fields[k] !== undefined && String(fields[k]).trim() !== "" && !re.test(String(fields[k]).trim())).map(([, , msg]) => msg);
}

async function submitProblems(app) {
  const out = SUBMIT_REQUIRED.filter(([k]) => !String(app[k] || "").trim()).map(([, label]) => label + " is required");
  out.push(...formatProblems(app));
  const docs = await repo.documents.list({ companyId: app.companyId, parentType: { $in: ["application", null] }, parentId: app._id }, { projection: { type: 1, verificationStatus: 1, version: 1 } });
  SUBMIT_DOCS.forEach((type) => {
    const mine = docs.filter((d) => d.type === type).sort((a, b) => (b.version || 0) - (a.version || 0));
    if (!mine.length) out.push(type + " document not uploaded");
    else if (mine[0].verificationStatus === "KYC Rejected") out.push(type + " was rejected; upload a new version");
  });
  return out;
}

async function notifyStatus(row, status, reason) {
  const notices = require("../notices/notices.service");
  const name = row.siteLocationName || "application";
  const link = { page: "applications", id: String(row._id) };
  if (status === "Submitted") {
    const deciders = await repo.users.list({ companyId: row.companyId, active: true, $or: [{ hierarchy: "Admin" }, { functionalRole: "Verifier" }, { hierarchy: "SubAdmin", functionalRole: { $in: ["", null] } }] }, { projection: { _id: 1 } });
    return notices.notify(row.companyId, deciders.map((u) => u._id), { kind: "application", title: "Application submitted: " + name, body: row.city || "", link, key: "app-submitted:" + row._id + ":" + Date.now() });
  }
  const owners = [row.createdBy, ...(await notices.franchiseUsers(row.companyId, row.franchiseId))];
  const title = status === "Approved" ? "Site approved: " + name : status === "Rejected" ? "Application rejected: " + name : "Correction needed: " + name;
  return notices.notify(row.companyId, owners, { kind: "application", title, body: reason, link, key: "app-" + status + ":" + row._id + ":" + Date.now() });
}

async function canTouchApplication(user, appRow) {
  if (!appRow) return false;
  if (!recordInProject(user, appRow)) return false;
  if (!FRANCHISE_LAYERS.includes(user.hierarchy)) return inRecordScope(user, appRow, ["createdBy", "ownerUserId"]);
  if (String(appRow.createdBy) === String(user._id)) return true;
  return inFranchiseScope(user, appRow.franchiseId);
}

function pickApp(body) {
  const out = {};
  APP_FIELDS.forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k];
  });
  if (body.nearestAtms) out.nearestAtms = atmGrid(body.nearestAtms, ["A", "B", "C", "D", "E"]);
  if (body.nearbyHitachi) out.nearbyHitachi = atmGrid(body.nearbyHitachi, ["A", "B"]);
  if (body.docChecklist && typeof body.docChecklist === "object") {
    out.docChecklist = {};
    DOC_CHECKLIST.forEach((k) => (out.docChecklist[k] = [true, "Yes", "yes", "Y"].includes(body.docChecklist[k]) ? "Yes" : "No"));
  }
  return out;
}

function atmGrid(raw, keys) {
  const out = {};
  keys.forEach((k) => {
    const v = typeof raw === "object" && raw ? raw[k] : k === keys[0] ? raw : "";
    const row = {};
    ATM_GRID_COLS.forEach((c) => (row[c] = ""));
    if (typeof v === "string") row.atmId = v.trim().slice(0, 200);
    else if (v && typeof v === "object") ATM_GRID_COLS.forEach((c) => (row[c] = String(v[c] === undefined ? "" : v[c]).trim().slice(0, 100)));
    if (row.siteType && !["Onsite", "Offsite"].includes(row.siteType)) row.siteType = "";
    out[k] = row;
  });
  return out;
}

module.exports = { canTouchApplication, pickApp, atmGrid, getApplications, postApplications, patchApplicationsById };
