const { handle } = require("../../utils/http");
const teamsService = require("./teams.service");

module.exports = {
  getTeams: handle(teamsService.getTeams),
  postTeams: handle(teamsService.postTeams),
  patchTeamsById: handle(teamsService.patchTeamsById),
};
