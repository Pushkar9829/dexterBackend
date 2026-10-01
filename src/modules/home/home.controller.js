const { handle } = require("../../utils/http");
const homeService = require("./home.service");

module.exports = {
  getHomeSummary: handle(homeService.getHomeSummary),
};
