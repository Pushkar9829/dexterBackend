const { handle } = require("../../utils/http");
const projectsService = require("./projects.service");

module.exports = {
  patchProjectsById: handle(projectsService.patchProjectsById),
  getProjects: handle(projectsService.getProjects),
  postProjects: handle(projectsService.postProjects),
};
