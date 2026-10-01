const { handle } = require("../../utils/http");
const siteProjectsService = require("./site-projects.service");
const pptxService = require("./pptx.service");

module.exports = {
  getSiteProjectsMeta: handle(siteProjectsService.getSiteProjectsMeta),
  getSiteProjects: handle(siteProjectsService.getSiteProjects),
  getSiteProjectsById: handle(siteProjectsService.getSiteProjectsById),
  postSiteProjects: handle(siteProjectsService.postSiteProjects),
  patchSiteProjectsById: handle(siteProjectsService.patchSiteProjectsById),
  patchSiteProjectsByIdStagesByIdx: handle(siteProjectsService.patchSiteProjectsByIdStagesByIdx),
  postSiteProjectsByIdStagesByIdxApprove: handle(siteProjectsService.postSiteProjectsByIdStagesByIdxApprove),
  postSiteProjectsByIdPptx: handle(pptxService.postSiteProjectsByIdPptx),
};
