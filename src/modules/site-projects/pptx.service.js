const { logRun } = require("../../adapters/common");
const { companyScope, isOfficeAdmin, canApproveApplication } = require("../../middlewares/rbac");
const repo = require("./site-projects.repository");
const { writeAudit } = require("../../utils/audit-writer");
const { readFileData } = require("../../utils/files");
const { oid } = require("../../utils/ids");
const { recordInProject } = require("../../utils/scope");

// ---------- Franchise project PPT ----------

async function projectPptx(project) {
  const { buildPptx } = require("../../utils/pptx");
  const photos = await repo.documents.list({ companyId: project.companyId, parentType: "project", parentId: project._id, mime: { $in: ["image/jpeg", "image/jpg", "image/png"] } }, { sort: { uploadedAt: 1 }, limit: 60 });
  const title = project.siteLocationName || project.siteNumber || "Project";
  const slides = [
    {
      title,
      lines: [
        "Site: " + (project.siteNumber || "-"),
        "Franchise: " + (project.franchiseName || "-"),
        "Stages approved: " + (project.stages || []).filter((s) => s.approvedAt).length + " of " + (project.stages || []).length,
        "Photos: " + photos.length,
        "Generated: " + new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      ],
      image: null,
    },
  ];
  for (const p of photos) {
    const when = p.capturedAt || p.uploadedAt;
    slides.push({
      title: p.type || "Photo",
      lines: [p.gps ? "GPS " + p.gps.lat + ", " + p.gps.lng : "GPS not recorded", when ? "Taken " + new Date(when).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "", p.fileName].filter(Boolean),
      image: { data: await readFileData(p), mime: p.mime === "image/jpg" ? "image/jpeg" : p.mime },
    });
  }
  const safe = String(title).replace(/[^\w.-]+/g, "_").slice(0, 60);
  return { fileName: "project-" + safe + ".pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", data: buildPptx(slides), photos: photos.length };
}

async function postSiteProjectsByIdPptx(ctx) {
  const project = await repo.site_projects.findById(oid(ctx.params.id));
  if (!project || !companyScope(ctx.user, project.companyId) || !recordInProject(ctx.user, project)) return { status: 404, body: { error: "not found" } };
  if (!isOfficeAdmin(ctx.user) && !canApproveApplication(ctx.user)) return { status: 403, body: { error: "office only" } };
  const file = await projectPptx(project);
  let mailId = null;
  if (ctx.body.mail) {
    const lu = (await repo.lookups.findOne({ companyId: project.companyId })) || {};
    if (!(lu.pptMailTo || []).length) return { status: 400, body: { error: "set PPT recipients on the Security page first" } };
    mailId = await require("../mail/mail.service").queueMailWithFile(project.companyId, { subject: "Project photos — " + (project.siteLocationName || project.siteNumber || ""), body: "Attached: stage photos with GPS and time for " + (project.siteLocationName || project.siteNumber || "the project") + ".", to: lu.pptMailTo, file, franchiseId: project.franchiseId });
    await logRun("ppt", true, "queued mail for " + (project.siteLocationName || project.siteNumber || project._id));
  }
  await writeAudit(ctx, "ProjectPptGenerated", { companyId: project.companyId, module: "CRM-03", recordId: project._id, work: file.photos + " photos" + (mailId ? ", mail queued" : "") });
  return { status: 200, body: { fileName: file.fileName, mime: file.mime, data: file.data.toString("base64"), photos: file.photos, mailId: mailId ? String(mailId) : null } };
}

module.exports = { projectPptx, postSiteProjectsByIdPptx };
