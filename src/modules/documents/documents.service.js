const { companyScope, isFieldStaff, isOfficeAdmin, can, canApproveApplication } = require("../../middlewares/rbac");
const { canTouchApplication } = require("../applications/applications.service");
const { FIELD_OPEN_PARENTS, PARENT_COLLECTIONS, OWN_PAGE_PARENTS, LOCKED_PARENT_STATUSES, SERVICE_PARENTS, MAIL_PARENTS, PARENT_MODULE, PROJECT_PARENTS } = require("./documents.model");
const repo = require("./documents.repository");

function nextVersion(companyId, parentId, type) {
  return repo.nextVersion(companyId, parentId, type);
}
const { writeAudit } = require("../../utils/audit-writer");
const { storeFile, readFileData, removeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { FRANCHISE_LAYERS, inFranchiseScope, recordInProject } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

async function canTouchParent(user, parentType, row) {
  if (!row) return false;
  if (parentType === "application") return canTouchApplication(user, row);
  if (parentType === "mail" && (row.status === "Draft" || !row.franchiseId)) return false;
  if (row.applicationId && FRANCHISE_LAYERS.includes(user.hierarchy)) {
    const appRow = await repo.applications.findById(row.applicationId);
    if (appRow && (await canTouchApplication(user, appRow))) return true;
  }
  return inFranchiseScope(user, row.franchiseId);
}

async function fieldCanOpen(user, doc) {
  const parentType = doc.parentType || "application";
  if (FIELD_OPEN_PARENTS.includes(parentType)) return true;
  const parent = await loadParent(parentType, doc.parentId, doc.companyId);
  if (!parent) return false;
  const me = String(user._id);
  if (parentType === "visit" || parentType === "inspection") return String(parent.officerId) === me;
  if (parentType === "complaint") return (parent.visitOfficerIds || []).some((x) => String(x) === me);
  if (parentType === "task") return [parent.assigneeId, parent.ownerId, parent.managerId].some((x) => x && String(x) === me);
  return false;
}

function officeCanOpen(user, parentType, parent) {
  if (parentType === "task") return !!parent && require("../tasks/tasks.service").canSee(user, parent);
  const mod = PARENT_MODULE[parentType];
  if (mod && !can(user, "View", mod)) return false;
  if (PROJECT_PARENTS.includes(parentType) && parent && !recordInProject(user, parent)) return false;
  return true;
}

async function loadParent(parentType, parentId, companyId) {
  const name = PARENT_COLLECTIONS[parentType];
  if (!name || !parentId) return null;
  return repo.collection(name).findOne({ _id: parentId, companyId });
}

async function getDocuments(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  if (ctx.query.type) filter.type = String(ctx.query.type);
  if (ctx.query.parentType) filter.parentType = String(ctx.query.parentType);
  if (ctx.query.parentId) filter.parentId = oid(ctx.query.parentId);
  let list = await repo.documents.list(filter, { projection: { data: 0 }, sort: { uploadedAt: -1 }, limit: 1000 });
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) {
    const cache = new Map();
    const kept = [];
    for (const d of list) {
      const key = d.parentType + ":" + d.parentId;
      if (!cache.has(key)) {
        const parent = await loadParent(d.parentType || "application", d.parentId, companyId);
        cache.set(key, await canTouchParent(ctx.user, d.parentType || "application", parent));
      }
      if (cache.get(key)) kept.push(d);
    }
    list = kept;
  } else if (isFieldStaff(ctx.user)) {
    const kept = [];
    for (const d of list) if (await fieldCanOpen(ctx.user, d)) kept.push(d);
    list = kept;
  }
  if (!FRANCHISE_LAYERS.includes(ctx.user.hierarchy) && !isFieldStaff(ctx.user)) {
    const cache = new Map();
    const kept = [];
    for (const d of list) {
      const parentType = d.parentType || "application";
      const key = parentType + ":" + d.parentId;
      if (!cache.has(key)) {
        const needsParent = parentType === "task" || PROJECT_PARENTS.includes(parentType);
        cache.set(key, officeCanOpen(ctx.user, parentType, needsParent ? await loadParent(parentType, d.parentId, companyId) : null));
      }
      if (cache.get(key)) kept.push(d);
    }
    list = kept;
  }
  const ids = [...new Set(list.flatMap((d) => [d.uploadedBy, d.verifiedBy]).filter(Boolean).map(String))];
  const names = new Map((await repo.users.list({ _id: { $in: ids.map(oid) } }, { projection: { name: 1, login: 1 } })).map((u) => [String(u._id), u.name || u.login]));
  list.forEach((d) => {
    d.uploadedByName = d.uploadedBy ? names.get(String(d.uploadedBy)) || "" : "";
    d.verifiedByName = d.verifiedBy ? names.get(String(d.verifiedBy)) || "" : "";
  });
  return { status: 200, body: { documents: list } };
}

async function postDocuments(ctx) {
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const parentId = oid(ctx.body.parentId);
  const type = String(ctx.body.type || "");
  if (!parentId || !type || !ctx.body.data) return { status: 400, body: { error: "parentId, type, data required" } };
  const parentType = String(ctx.body.parentType || "application");
  if (!PARENT_COLLECTIONS[parentType]) return { status: 400, body: { error: "unknown parentType" } };
  if (OWN_PAGE_PARENTS[parentType]) return { status: 400, body: { error: "attach these files from the " + OWN_PAGE_PARENTS[parentType] + " page" } };
  const parent = await loadParent(parentType, parentId, companyId);
  if (!parent) return { status: 404, body: { error: parentType + " not found" } };
  if (!(await canTouchParent(ctx.user, parentType, parent))) {
    return { status: 403, body: { error: "own records only" } };
  }
  if ((LOCKED_PARENT_STATUSES[parentType] || []).includes(parent.status)) {
    return { status: 400, body: { error: parentType + " is " + parent.status + "; no more files" } };
  }
  if (parent.officerId && isFieldStaff(ctx.user) && String(parent.officerId) !== String(ctx.user._id)) {
    return { status: 403, body: { error: "assigned officer only" } };
  }
  if (parentType === "complaint" && isFieldStaff(ctx.user) && !(parent.visitOfficerIds || []).some((x) => String(x) === String(ctx.user._id))) {
    return { status: 403, body: { error: "assigned visits only" } };
  }
  if ((parentType === "visit" || parentType === "inspection") && String(parent.officerId) !== String(ctx.user._id) && !isOfficeAdmin(ctx.user)) {
    return { status: 403, body: { error: "assigned officer only" } };
  }
  const file = checkFile(ctx.body.fileName, ctx.body.data, null, { video: SERVICE_PARENTS.includes(parentType) });
  if (file.error) return { status: 400, body: { error: file.error } };
  const version = await nextVersion(companyId, parentId, type);
  const doc = {
    companyId,
    parentType,
    parentId,
    gps: ctx.body.lat && ctx.body.lng ? { lat: String(ctx.body.lat), lng: String(ctx.body.lng) } : null,
    capturedAt: ctx.body.capturedAt ? new Date(ctx.body.capturedAt) : null,
    type,
    version,
    fileName: file.name,
    mime: file.mime,
    ...(await storeFile(file.data, file.name, file.mime)),
    status: parentType === "application" ? "KYC Pending" : "Documents Submitted",
    verificationStatus: "Under Verification",
    franchiseId: parent.franchiseId || null,
    uploadedBy: ctx.user._id,
    uploadedAt: new Date(),
    expiry: ctx.body.expiry || null,
    rejectionReason: "",
  };
  const result = await repo.documents.insert(doc);
  const service = SERVICE_PARENTS.includes(parentType);
  await writeAudit(ctx, parentType === "project" ? "EvidenceUploaded" : service ? "ServicePhotoUploaded" : type === "Affidavit" ? "AffidavitUploaded" : "DocumentUploaded", {
    companyId,
    module: parentType === "project" ? "CRM-03" : service ? "CRM-05" : "CRM-02",
    recordId: result.insertedId,
    work: parentType + " " + type + " v" + version,
  });
  if ((parentType === "agreement" || parentType === "loi") && ["Pending", "Resubmission Required"].includes(parent.status)) {
    await repo.collection(PARENT_COLLECTIONS[parentType]).updateById(parent._id, { $set: { status: "Uploaded", updatedAt: new Date() } });
    await writeAudit(ctx, parentType === "agreement" ? "AgreementStatusChanged" : "LOIUpdated", {
      companyId,
      module: "CRM-02",
      recordId: parent._id,
      before: { status: parent.status },
      after: { status: "Uploaded" },
    });
  }
  return { status: 200, body: { id: String(result.insertedId), version } };
}

async function getDocumentsByIdFile(ctx) {
  const id = oid(ctx.params.id);
  const row = await repo.documents.findById(id);
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  if (FRANCHISE_LAYERS.includes(ctx.user.hierarchy)) {
    const parentType = row.parentType || "application";
    const parent = await loadParent(parentType, row.parentId, row.companyId);
    if (!(await canTouchParent(ctx.user, parentType, parent))) return { status: 404, body: { error: "not found" } };
  } else if (isFieldStaff(ctx.user)) {
    if (!(await fieldCanOpen(ctx.user, row))) return { status: 404, body: { error: "not found" } };
  } else {
    const parentType = row.parentType || "application";
    const parent = await loadParent(parentType, row.parentId, row.companyId);
    const mine = String(row.uploadedBy) === String(ctx.user._id);
    if (!mine && !officeCanOpen(ctx.user, parentType, parent)) return { status: 404, body: { error: "not found" } };
    if (parentType === "application") {
      const h = ctx.user.hierarchy;
      const decider = ["Admin", "DexterIndiaCompanyTeam", "Director"].includes(h) || ctx.user.functionalRole === "Verifier" || (h === "SubAdmin" && !ctx.user.functionalRole);
      if (!mine && !can(ctx.user, "Export", "CRM-02") && !decider) return { status: 403, body: { error: "KYC download needs the Export action (or Verifier / Admin)" } };
    }
  }
  return { status: 200, body: { fileName: row.fileName, mime: row.mime, data: (await readFileData(row)).toString("base64") } };
}

async function patchDocumentsByIdVerify(ctx) {
  if (!canApproveApplication(ctx.user) && !isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const id = oid(ctx.params.id);
  const row = await repo.documents.findById(id);
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const ok = !!ctx.body.approve;
  const decided = ["KYC Verified", "KYC Rejected"].includes(row.verificationStatus);
  const override = ["Admin", "DexterIndiaCompanyTeam"].includes(ctx.user.hierarchy);
  if (decided && !override) return { status: 400, body: { error: "already " + row.verificationStatus + "; only Admin can change the decision" } };
  if (decided && !String(ctx.body.reason || ctx.body.rejectionReason || "").trim()) return { status: 400, body: { error: "changing a decided document needs a reason" } };
  const set = {
    verificationStatus: ok ? "KYC Verified" : "KYC Rejected",
    status: ok ? "KYC Verified" : "Resubmission Required",
    verifiedBy: ctx.user._id,
    verifiedAt: new Date(),
    rejectionReason: String(ctx.body.rejectionReason || ""),
  };
  if (ctx.body.remarks !== undefined) set.remarks = String(ctx.body.remarks).trim().slice(0, 1000);
  await repo.documents.updateById(id, { $set: set });
  await writeAudit(ctx, ok ? "KYCVerified" : "KYCRejected", { companyId: row.companyId, module: "CRM-02", recordId: id, before: decided ? { verificationStatus: row.verificationStatus } : null, after: set, work: decided ? "Admin override: " + String(ctx.body.reason || ctx.body.rejectionReason) : "" });
  if (!ok && row.franchiseId) {
    const fr = await repo.franchises.findOne({ _id: row.franchiseId, companyId: row.companyId });
    const to = await require("../mail/mail.service").franchiseEmail(row.companyId, row.franchiseId, null);
    if (to.length) await require("../mail/mail.service").queueAutoMail(row.companyId, { templateKey: "kyc-reject", vars: { franchise: fr ? fr.name : "", document: row.type || row.fileName, reason: set.rejectionReason }, to, franchiseId: row.franchiseId }).catch(() => null);
  }
  return { status: 200, body: { ok: true } };
}

async function patchDocumentsByIdRemarks(ctx) {
  if (!canApproveApplication(ctx.user) && !isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "Verifier / Admin only" } };
  const row = await repo.documents.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const remarks = String(ctx.body.remarks || "").trim().slice(0, 1000);
  await repo.documents.updateById(row._id, { $set: { remarks, remarksBy: ctx.user._id, remarksAt: new Date() } });
  await writeAudit(ctx, "DocumentRemark", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before: { remarks: row.remarks || "" }, after: { remarks }, work: row.type + " v" + row.version });
  return { status: 200, body: { ok: true } };
}

async function deleteDocumentsById(ctx) {
  const row = await repo.documents.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  if (MAIL_PARENTS.includes(row.parentType)) return { status: 400, body: { error: "manage mail and tracker files from the Mail page" } };
  const own = String(row.uploadedBy) === String(ctx.user._id);
  const granted = can(ctx.user, "Delete", "CRM-02");
  if (!granted && !(own && row.verificationStatus === "Under Verification")) return { status: 403, body: { error: "only the uploader (before verification) or a user with Delete can remove this file" } };
  const parent = PARENT_COLLECTIONS[row.parentType] ? await repo.collection(PARENT_COLLECTIONS[row.parentType]).findById(row.parentId) : null;
  if (parent && (LOCKED_PARENT_STATUSES[row.parentType] || []).includes(parent.status)) return { status: 400, body: { error: row.parentType + " is " + parent.status + "; files are locked" } };
  const reason = String(ctx.body.reason || "").trim();
  if (!reason) return { status: 400, body: { error: "reason required" } };
  await repo.documents.deleteById(row._id);
  await removeFile(row);
  await writeAudit(ctx, "DocumentDeleted", {
    companyId: row.companyId,
    module: row.parentType === "project" ? "CRM-03" : "CRM-02",
    recordId: row._id,
    before: { parentType: row.parentType, parentId: row.parentId, type: row.type, version: row.version, fileName: row.fileName, verificationStatus: row.verificationStatus },
    work: reason,
  });
  return { status: 200, body: { ok: true } };
}

module.exports = { nextVersion, canTouchParent, fieldCanOpen, loadParent, getDocuments, postDocuments, getDocumentsByIdFile, patchDocumentsByIdVerify, patchDocumentsByIdRemarks, deleteDocumentsById };
