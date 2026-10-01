const { handle } = require("../../utils/http");
const hrmsService = require("./hrms.service");

module.exports = {
  postHrmsWebhook: handle(hrmsService.postHrmsWebhook),
};
