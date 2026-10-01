const { isOfficeAdmin, officeRole, companyScope, canApproveApplication } = require("../../middlewares/rbac");
const { AppError } = require("../../middlewares/errors");
const { notify, franchiseUsers } = require("../notices/notices.service");
const { STAGES, STAGE_STATUSES, BRANDING_ITEMS, BOARD_FIELDS, READINESS_ITEMS, HEADER_FIELDS, NO_EVIDENCE_STAGES } = require("./site-projects.model");
const repo = require("./site-projects.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { normDate, istToday } = require("../../utils/dates");
const { storeFile } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { recordInProject, inFranchiseScope, applyFranchiseFilter, applyRecordProject } = require("../../utils/scope");
const { checkFile } = require("../../utils/upload");

const dayDate = (iso) => new Date(iso + "T00:00:00Z");

function canRunProject(user) {
  return isOfficeAdmin(user) || officeRole(user, ["ServiceProjectOps", "Executive"]);
}

function evidenceType(stageName) {
  return "Stage: " + stageName;
}

function summarize(p) {
  const approved = p.stages.filter((s) => s.approvedAt).length;
  const current = p.stages.find((s) => !s.approvedAt);
  const view = p.completedAt ? "Completed" : p.held ? "Held" : "Active";
  const today = istToday();
  const stages = p.stages.map((s) => ({ ...s, overdue: !s.approvedAt && !!s.dueDate && s.dueDate < today }));
  const late = stages.filter((s) => s.overdue);
  return { ...p, stages, progress: Math.round((approved / STAGES.length) * 100), currentStage: current ? current.name : null, currentDue: current ? current.dueDate || "" : "", overdueStages: late.map((s) => s.name), delayed: view === "Active" && late.length > 0, view };
}

async function loadProject(ctx) {
  const row = await repo.site_projects.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId) || !recordInProject(ctx.user, row)) {
    throw new AppError(404, "not found");
  }
  if (!(await inFranchiseScope(ctx.user, row.franchiseId))) {
    throw new AppError(403, "own records only");
  }
  return row;
}

function stageIndex(ctx) {
  const idx = Number(ctx.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= STAGES.length) {
    throw new AppError(400, "bad stage");
  }
  return idx;
}

async function stageTask(project, idx, actor) {
  const lu = (await repo.lookups.findOne({ companyId: project.companyId })) || {};
  await repo.tasks.updateMany(
    { companyId: project.companyId, projectId: project._id, source: "Project", status: { $nin: ["Completed", "Closed"] } },
    { $set: { status: "Completed", completedAt: new Date(), percent: 100, updatedAt: new Date() }, $push: { history: { at: new Date(), by: actor._id || null, byName: actor.name || actor.login || "system", action: "Completed", to: "Completed", remark: "stage approved" } } }
  );
  if (lu.projectAutoTask === false || idx >= STAGES.length) return null;
  const { createTask } = require("../tasks/tasks.service");
  const b = { title: "Project " + (project.siteLocationName || project.siteNumber || project._id) + ": " + STAGES[idx], description: "Complete and upload evidence for the " + STAGES[idx] + " stage", source: "Project", type: "Project", category: "Field", priority: "Medium", projectId: project._id, franchiseId: project.franchiseId, assigneeId: project.createdBy };
  let r = await createTask(project.companyId, actor, b, { allowPastDue: true });
  if (r.error) r = await createTask(project.companyId, actor, { ...b, assigneeId: null }, { allowPastDue: true });
  return r.task || null;
}

async function companyStages(companyId) {
  const lu = (await repo.lookups.findOne({ companyId })) || {};
  const saved = Array.isArray(lu.stageStatuses) && lu.stageStatuses.length ? [...new Set(lu.stageStatuses.map((s) => (s === "Completed" ? "Complete" : s)))] : null;
  return { statuses: saved || STAGE_STATUSES, owners: lu.stageOwners || {} };
}

async function liveBoards(companyId, projects) {
  if (!projects.length) return projects;
  const frIds = [...new Set(projects.map((p) => p.franchiseId).filter(Boolean).map(String))].map(oid);
  const appIds = projects.map((p) => p.applicationId).filter(Boolean);
  const latest = (rows, key) => {
    const m = new Map();
    rows.forEach((r) => {
      const k = String(r[key]);
      if (!m.has(k) || new Date(r.updatedAt || r.createdAt) > new Date(m.get(k).updatedAt || m.get(k).createdAt)) m.set(k, r);
    });
    return m;
  };
  const [sds, agrs, apna, pays, gsts] = await Promise.all([
    repo.security_deposits.list({ companyId, franchiseId: { $in: frIds } }, { projection: { franchiseId: 1, status: 1, createdAt: 1, updatedAt: 1 } }),
    repo.agreements.list({ companyId, applicationId: { $in: appIds } }, { projection: { applicationId: 1, status: 1, createdAt: 1, updatedAt: 1 } }),
    repo.apna_mappings.list({ companyId, franchiseId: { $in: frIds } }, { projection: { franchiseId: 1, status: 1, createdAt: 1, updatedAt: 1 } }),
    repo.payout_accounts.list({ companyId, franchiseId: { $in: frIds } }, { projection: { franchiseId: 1, status: 1, createdAt: 1, updatedAt: 1 } }),
    repo.gst_bills.list({ companyId, franchiseId: { $in: frIds } }, { projection: { franchiseId: 1, status: 1, createdAt: 1, updatedAt: 1 } }),
  ]);
  const m = { sd: latest(sds, "franchiseId"), agreementStatus: latest(agrs, "applicationId"), apnaRegistration: latest(apna, "franchiseId"), payoutAccountStatus: latest(pays, "franchiseId"), gstStatus: latest(gsts, "franchiseId") };
  return projects.map((p) => {
    const board = { ...(p.board || {}) };
    const live = {};
    for (const [field, map] of Object.entries(m)) {
      const hit = map.get(String(field === "agreementStatus" ? p.applicationId : p.franchiseId));
      if (hit) {
        board[field] = hit.status || (field === "apnaRegistration" ? "Registered" : board[field]);
        live[field] = true;
      }
    }
    return { ...p, board, boardLive: live };
  });
}

async function getSiteProjectsMeta(ctx) {
  const s = await companyStages(oid(ctx.user.companyId));
  return { status: 200, body: { stages: STAGES, stageStatuses: s.statuses, stageOwners: s.owners, brandingItems: BRANDING_ITEMS, boardFields: BOARD_FIELDS, readinessItems: READINESS_ITEMS } };
}

async function getSiteProjects(ctx) {
  const companyId = oid(ctx.user.companyId);
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "franchiseId");
  applyRecordProject(ctx.user, filter);
  const list = (await liveBoards(companyId, await repo.site_projects.list(filter, { sort: { createdAt: -1 }, limit: 500 }))).map(summarize);
  const view = String(ctx.query.view || "");
  return { status: 200, body: { projects: view ? list.filter((p) => p.view === view) : list } };
}

async function getSiteProjectsById(ctx) {
  const row = await loadProject(ctx);
  const evidence = await repo.documents.list({ companyId: row.companyId, parentType: "project", parentId: row._id }, { projection: { data: 0 }, sort: { uploadedAt: -1 } });
  return { status: 200, body: { project: summarize((await liveBoards(row.companyId, [row]))[0]), evidence } };
}

async function postSiteProjects(ctx) {
  if (!canRunProject(ctx.user)) return { status: 403, body: { error: "Admin / Project Ops only" } };
  const companyId = oid(ctx.user.companyId);
  const appRow = await repo.applications.findOne({ _id: oid(ctx.body.applicationId), companyId });
  if (!appRow) return { status: 404, body: { error: "application not found" } };
  if (appRow.status !== "Approved") return { status: 400, body: { error: "project starts from an approved site" } };
  const dup = await repo.site_projects.findOne({ companyId, applicationId: appRow._id });
  if (dup) return { status: 409, body: { error: "project already exists for this site" } };
  const loi = await repo.lois.findOne({ companyId, applicationId: appRow._id });
  const franchise = appRow.franchiseId ? await repo.franchises.findById(appRow.franchiseId) : null;
  const stageOwners = (await companyStages(companyId)).owners;
  const now = new Date();
  const doc = {
    companyId,
    applicationId: appRow._id,
    projectId: appRow.projectId || null,
    franchiseId: appRow.franchiseId || null,
    franchiseName: franchise ? franchise.name : "",
    siteLocationName: appRow.siteLocationName || "",
    siteNumber: appRow.siteNumber || "",
    model: appRow.model || "",
    location: {
      address: appRow.address || "",
      city: appRow.city || "",
      state: appRow.state || "",
      pin: appRow.pin || "",
      lat: appRow.lat || "",
      lng: appRow.lng || "",
    },
    contacts: { landlord: appRow.landlordName || "", mobile: appRow.contactNumber || "", email: appRow.email || "" },
    loiCode: loi ? loi.loiCode : "",
    loiDate: loi && loi.createdAt ? loi.createdAt.toISOString().slice(0, 10) : "",
    applyDate: appRow.createdAt ? appRow.createdAt.toISOString().slice(0, 10) : "",
    visitDate: "",
    visitBy: "",
    possessionDate: "",
    atmRef: null,
    atmId: "",
    projectName: String(ctx.body.projectName || "").trim() || [appRow.siteLocationName, appRow.city].filter(Boolean).join(", "),
    stages: STAGES.map((name) => ({ name, status: "Pending", date: "", startDate: "", dueDate: "", owner: stageOwners[name] || "", remarks: "", extra: {}, approvedBy: null, approvedAt: null })),
    board: { sd: "Pending", agreementStatus: appRow.agreementStatus || "Pending", apnaRegistration: "Pending", wlaAccountStatus: "Pending", payoutAccountStatus: "Pending", gstStatus: "Pending", projectedCompletion: "" },
    readiness: Object.fromEntries(READINESS_ITEMS.map((k) => [k, "Pending"])),
    held: false,
    heldReason: "",
    techLiveDate: null,
    cashLiveDate: null,
    completedAt: null,
    createdBy: ctx.user._id,
    createdAt: now,
    updatedAt: now,
  };
  doc.stages[0].status = "Assigned";
  doc.stages[0].date = now.toISOString().slice(0, 10);
  doc.stages[0].startDate = istToday();
  const selfie = ctx.body.selfie && ctx.body.selfie.data ? checkFile(ctx.body.selfie.fileName, ctx.body.selfie.data) : null;
  if (selfie && selfie.error) return { status: 400, body: { error: "selfie: " + selfie.error } };
  if (selfie && !selfie.mime.startsWith("image/")) return { status: 400, body: { error: "selfie must be a photo" } };
  const result = await repo.site_projects.insert(doc);
  doc._id = result.insertedId;
  if (selfie) {
    const s = ctx.body.selfie;
    await repo.documents.insert({
      companyId,
      parentType: "project",
      parentId: doc._id,
      type: "Visit selfie",
      version: 1,
      fileName: selfie.name,
      mime: selfie.mime,
      ...(await storeFile(selfie.data, selfie.name, selfie.mime)),
      gps: s.lat && s.lng ? { lat: String(s.lat), lng: String(s.lng) } : null,
      capturedAt: s.capturedAt ? new Date(s.capturedAt) : new Date(),
      status: "Documents Submitted",
      franchiseId: doc.franchiseId,
      uploadedBy: ctx.user._id,
      uploadedAt: new Date(),
    });
    await writeAudit(ctx, "EvidenceUploaded", { companyId, module: "CRM-03", recordId: doc._id, work: "Visit selfie" + (s.lat ? " @" + s.lat + "," + s.lng : "") });
  }
  await writeAudit(ctx, "ProjectCreated", { companyId, module: "CRM-03", recordId: result.insertedId, work: doc.siteLocationName });
  const t = await stageTask(doc, 1, ctx.user);
  if (t) await writeAudit(ctx, "TaskCreated", { companyId, module: "CRM-06", recordId: t._id, work: t.taskNo + " from project " + doc.siteLocationName });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function patchSiteProjectsById(ctx) {
  const row = await loadProject(ctx);
  if (!canRunProject(ctx.user)) return { status: 403, body: { error: "Admin / Project Ops only" } };
  const b = ctx.body;
  const set = { updatedAt: new Date() };
  HEADER_FIELDS.forEach((k) => {
    if (b[k] !== undefined) set[k] = String(b[k]);
  });
  if (b.board) BOARD_FIELDS.forEach((k) => b.board[k] !== undefined && (set["board." + k] = String(b.board[k])));
  if (b.readiness) READINESS_ITEMS.forEach((k) => b.readiness[k] !== undefined && (set["readiness." + k] = String(b.readiness[k])));
  if (b.held !== undefined) {
    if (row.completedAt) return { status: 400, body: { error: "project already completed" } };
    set.held = !!b.held;
    set.heldReason = set.held ? String(b.heldReason || "").trim() : "";
    if (set.held && !set.heldReason) return { status: 400, body: { error: "reason required to hold a project" } };
  }
  if (b.atmId !== undefined && String(b.atmId).trim() !== (row.atmId || "")) {
    if (row.cashLiveDate) return { status: 400, body: { error: "project is Cash Live; the linked ATM cannot change" } };
    if (!String(b.atmId).trim()) {
      set.atmRef = null;
      set.atmId = "";
    } else {
      const atm = await repo.atms.findOne({ companyId: row.companyId, atmId: String(b.atmId).trim() });
      if (!atm) return { status: 400, body: { error: "ATM ID not in ATM Master for this company" } };
      if (atm.franchiseId && row.franchiseId && String(atm.franchiseId) !== String(row.franchiseId)) {
        return { status: 400, body: { error: "ATM " + atm.atmId + " belongs to another franchise" } };
      }
      const other = await repo.site_projects.findOne({ companyId: row.companyId, atmRef: atm._id, _id: { $ne: row._id } });
      if (other) return { status: 409, body: { error: "ATM " + atm.atmId + " is already linked to project " + (other.siteLocationName || other._id) } };
      if (atm.cashLiveDate) return { status: 400, body: { error: "ATM " + atm.atmId + " is already Cash Live" } };
      set.atmRef = atm._id;
      set.atmId = atm.atmId;
    }
  }
  await repo.site_projects.updateById(row._id, { $set: set });
  const event = b.held !== undefined ? (b.held ? "ProjectHeld" : "ProjectResumed") : "ProjectUpdated";
  const before = {};
  const after = {};
  for (const k of Object.keys(set)) {
    if (k === "updatedAt") continue;
    const v = k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), row);
    before[k.replace(/\./g, "/")] = v === undefined ? null : v;
    after[k.replace(/\./g, "/")] = set[k];
  }
  await writeAudit(ctx, event, { companyId: row.companyId, module: "CRM-03", recordId: row._id, before, after });
  return { status: 200, body: { ok: true } };
}

async function patchSiteProjectsByIdStagesByIdx(ctx) {
  const row = await loadProject(ctx);
  const idx = stageIndex(ctx);
  if (!canRunProject(ctx.user)) return { status: 403, body: { error: "Admin / Project Ops only" } };
  if (row.held) return { status: 400, body: { error: "project is on hold" } };
  const planOnly = Object.keys(ctx.body).length > 0 && Object.keys(ctx.body).every((k) => ["startDate", "dueDate"].includes(k));
  if (idx > 0 && !row.stages[idx - 1].approvedAt && !planOnly) return { status: 400, body: { error: row.stages[idx - 1].name + " must be approved first" } };
  const stage = row.stages[idx];
  const isAdmin = ctx.user.hierarchy === "Admin" || ctx.user.hierarchy === "DexterIndiaCompanyTeam";
  if (stage.approvedAt && !isAdmin) return { status: 403, body: { error: "stage approved; Admin override only" } };
  const b = ctx.body;
  if (b.date) {
    const iso = normDate(b.date);
    if (!iso) return { status: 400, body: { error: "date must be YYYY-MM-DD or DD.MM.YYYY" } };
    b.date = iso;
  }
  const set = { updatedAt: new Date() };
  if (b.status !== undefined) {
    if (!(await companyStages(row.companyId)).statuses.includes(b.status)) return { status: 400, body: { error: "unknown stage status" } };
    set["stages." + idx + ".status"] = b.status;
  }
  ["date", "owner", "remarks"].forEach((k) => b[k] !== undefined && (set["stages." + idx + "." + k] = String(b[k])));
  for (const k of ["startDate", "dueDate"]) {
    if (b[k] === undefined) continue;
    const iso = b[k] ? normDate(b[k]) : "";
    if (b[k] && !iso) return { status: 400, body: { error: (k === "startDate" ? "start" : "due") + " date must be YYYY-MM-DD or DD.MM.YYYY" } };
    set["stages." + idx + "." + k] = iso;
  }
  const s0 = set["stages." + idx + ".startDate"] ?? stage.startDate ?? "";
  const d0 = set["stages." + idx + ".dueDate"] ?? stage.dueDate ?? "";
  if (s0 && d0 && d0 < s0) return { status: 400, body: { error: "due date is before the start date" } };
  if (b.extra && stage.name === "Branding") {
    BRANDING_ITEMS.forEach((k) => b.extra[k] !== undefined && (set["stages." + idx + ".extra." + k] = String(b.extra[k])));
  }
  const liveStage = stage.approvedAt && ["Tech Live", "Cash Live"].includes(stage.name) && b.date !== undefined && String(b.date) !== stage.date;
  if (liveStage) {
    if (!b.date) return { status: 400, body: { error: stage.name + " date required" } };
    if (stage.name === "Tech Live") set.techLiveDate = dayDate(b.date);
    else {
      const clash = row.atmRef
        ? await repo.ops_txn.findOne({ companyId: row.companyId, atmId: row.atmId, date: { $lt: String(b.date) } })
        : null;
      if (clash) return { status: 400, body: { error: "daily TXN already exists on " + clash.date + ", before the new Cash Live date" } };
      set.cashLiveDate = dayDate(b.date);
      if (row.atmRef) {
        await repo.atms.updateById(row.atmRef, { $set: { cashLiveDate: dayDate(b.date), updatedAt: new Date() } });
        await repo.atms.updateOne({ _id: row.atmRef, status: "Under Installation" }, { $set: { status: "Active" } });
        await writeAudit(ctx, "ATMUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row.atmRef, before: { cashLiveDate: row.cashLiveDate }, after: { cashLiveDate: String(b.date) } });
      }
    }
  }
  await repo.site_projects.updateById(row._id, { $set: set });
  if (b.status !== undefined && b.status !== stage.status) {
    await notify(row.companyId, [...(await franchiseUsers(row.companyId, row.franchiseId)), row.createdBy].filter((x) => String(x) !== String(ctx.user._id)), {
      kind: "stage",
      title: stage.name + ": " + b.status,
      body: (row.projectName || row.siteLocationName || row.siteNumber || "Project") + (b.remarks ? " · " + String(b.remarks).slice(0, 120) : ""),
      link: { page: "projects", id: String(row._id) },
      key: "stage-status:" + row._id + ":" + idx + ":" + b.status,
    });
  }
  if (liveStage) await writeAudit(ctx, stage.name === "Tech Live" ? "TechLiveSet" : "CashLiveSet", { companyId: row.companyId, module: "CRM-03", recordId: row._id, work: stage.name + " " + b.date + " (Admin override)" });
  await writeAudit(ctx, "StageChanged", {
    companyId: row.companyId,
    module: "CRM-03",
    recordId: row._id,
    before: { stage: stage.name, status: stage.status, date: stage.date, owner: stage.owner || "", remarks: stage.remarks || "", extra: stage.extra || null },
    after: Object.fromEntries(Object.entries(set).map(([k, v]) => [k.replace(/\./g, "/"), v])),
    work: stage.name + (stage.approvedAt ? " (Admin override)" : ""),
  });
  return { status: 200, body: { ok: true } };
}

async function postSiteProjectsByIdStagesByIdxApprove(ctx) {
  const row = await loadProject(ctx);
  const idx = stageIndex(ctx);
  if (!canApproveApplication(ctx.user)) return { status: 403, body: { error: "only Verifier / Admin can approve a stage" } };
  if (row.held) return { status: 400, body: { error: "project is on hold" } };
  const stage = row.stages[idx];
  if (stage.approvedAt) return { status: 400, body: { error: "already approved" } };
  if (idx > 0 && !row.stages[idx - 1].approvedAt) return { status: 400, body: { error: row.stages[idx - 1].name + " must be approved first" } };
  if (!NO_EVIDENCE_STAGES.includes(stage.name)) {
    const ev = await repo.documents.count({ companyId: row.companyId, parentType: "project", parentId: row._id, type: evidenceType(stage.name) });
    if (!ev) return { status: 400, body: { error: "upload evidence for " + stage.name + " first" } };
  }
  const rawDate = String(ctx.body.date || stage.date || "");
  const date = rawDate ? normDate(rawDate) : "";
  if (rawDate && !date) return { status: 400, body: { error: "date must be YYYY-MM-DD or DD.MM.YYYY" } };
  const set = {
    ["stages." + idx + ".approvedBy"]: ctx.user._id,
    ["stages." + idx + ".approvedAt"]: new Date(),
    ["stages." + idx + ".status"]: ["Pending", "Assigned", "In Progress"].includes(stage.status) ? "Complete" : stage.status,
    updatedAt: new Date(),
  };
  if (date) set["stages." + idx + ".date"] = date;
  const events = ["StageChanged"];

  if (stage.name === "Tech Live") {
    if (!date) return { status: 400, body: { error: "Tech Live date required" } };
    set.techLiveDate = dayDate(date);
    events.push("TechLiveSet");
  }
  if (stage.name === "Cash Live") {
    if (!date) return { status: 400, body: { error: "Cash Live date required" } };
    if (!row.atmRef) return { status: 400, body: { error: "link the ATM from ATM Master before Cash Live" } };
    const atm = await repo.atms.findOne({ _id: row.atmRef, companyId: row.companyId });
    if (!atm || !atm.atmSerialNumber || !atm.machineTypeModel) return { status: 400, body: { error: "ATM Master row needs serial number and machine type" } };
    set.cashLiveDate = dayDate(date);
    await repo.atms.updateById(atm._id, { $set: { cashLiveDate: dayDate(date), franchiseId: atm.franchiseId || row.franchiseId, ...(!atm.status || atm.status === "Under Installation" ? { status: "Active" } : {}), updatedAt: new Date() } });
    await writeAudit(ctx, "ATMUpdated", { companyId: row.companyId, module: "CRM-02", recordId: atm._id, before: { cashLiveDate: atm.cashLiveDate || null }, after: { cashLiveDate: date } });
    events.push("CashLiveSet");
  }
  if (stage.name === "Project Completed") set.completedAt = new Date();
  if (idx + 1 < row.stages.length && !row.stages[idx + 1].startDate) set["stages." + (idx + 1) + ".startDate"] = istToday();

  await repo.site_projects.updateById(row._id, { $set: set });
  await notify(row.companyId, [...(await franchiseUsers(row.companyId, row.franchiseId)), row.createdBy], {
    kind: "stage",
    title: "Stage complete: " + stage.name,
    body: (row.siteLocationName || row.siteNumber || "Project") + (date ? " · " + date : ""),
    link: { page: "projects", id: String(row._id) },
    key: "stage:" + row._id + ":" + idx,
  });
  for (const ev of events) {
    await writeAudit(ctx, ev, { companyId: row.companyId, module: "CRM-03", recordId: row._id, before: { stage: stage.name, status: stage.status, date: stage.date || "", approvedAt: null }, after: { status: set["stages." + idx + ".status"], date: date || stage.date || "", approvedAt: set["stages." + idx + ".approvedAt"] }, work: stage.name + (date ? " " + date : "") });
  }
  const t = await stageTask(row, idx + 1, ctx.user);
  if (t) await writeAudit(ctx, "TaskCreated", { companyId: row.companyId, module: "CRM-06", recordId: t._id, work: t.taskNo + " from project stage " + STAGES[idx + 1] });
  return { status: 200, body: { ok: true } };
}

const STAGE_IMPORT_FIELDS = ["status", "date", "startDate", "dueDate", "owner", "remarks"];

// Each row goes through the same stage update as the screen, so order, hold, approval-lock and Cash Live rules all apply.
require("../imports/imports.registry").registerImporter("project-stages", {
  headers: ["project", "stage", ...STAGE_IMPORT_FIELDS],
  required: ["project", "stage"],
  canImport: canRunProject,
  denied: "stage import is Admin / Project Ops only",
  event: "StagesImported",
  module: "CRM-03",
  rule: "accept good rows, reject bad rows; project = site number, ATM ID or project name; stage = stage name or number 1–" + STAGES.length + "; blank cells are left unchanged; approval is never imported",
  async save(ictx, input) {
    const key = String(input.project || "").trim();
    const st = String(input.stage || "").trim();
    const idx = /^\d+$/.test(st) ? Number(st) - 1 : STAGES.findIndex((n) => n.toLowerCase() === st.toLowerCase());
    if (idx < 0 || idx >= STAGES.length) return { errors: [{ column: "stage", reason: "unknown stage: " + st }] };
    const found = await repo.site_projects.list({ companyId: ictx.companyId, $or: [{ siteNumber: key }, { atmId: key }, { projectName: key }, { siteLocationName: key }] }, { projection: { _id: 1 }, limit: 2 });
    if (!found.length) return { errors: [{ column: "project", reason: "project not found: " + key }] };
    if (found.length > 1) return { errors: [{ column: "project", reason: "more than one project matches " + key + "; use the site number" }] };
    const body = {};
    STAGE_IMPORT_FIELDS.forEach((k) => String(input[k] ?? "").trim() !== "" && (body[k] = String(input[k]).trim()));
    if (!Object.keys(body).length) return { errors: [{ column: "", reason: "nothing to update on this row" }] };
    let r;
    try {
      r = await patchSiteProjectsByIdStagesByIdx({ ...ictx.ctx, params: { id: String(found[0]._id), idx: String(idx) }, body });
    } catch (err) {
      return { errors: [{ column: "project", reason: err.message }] };
    }
    if (r.status !== 200) return { errors: [{ column: "", reason: (r.body && r.body.error) || "not saved" }] };
    return { ok: true, key: key + " · " + STAGES[idx] };
  },
});

module.exports = { dayDate, canRunProject, evidenceType, summarize, loadProject, stageIndex, stageTask, companyStages, liveBoards, getSiteProjectsMeta, getSiteProjects, getSiteProjectsById, postSiteProjects, patchSiteProjectsById, patchSiteProjectsByIdStagesByIdx, postSiteProjectsByIdStagesByIdxApprove };
