const { handle } = require("../../utils/http");
const noticesService = require("./notices.service");

module.exports = {
  getNotices: handle(noticesService.getNotices),
  getNoticesSettings: handle(noticesService.getNoticesSettings),
  patchNoticesSettings: handle(noticesService.patchNoticesSettings),
  patchNoticesByIdRead: handle(noticesService.patchNoticesByIdRead),
  postNoticesReadAll: handle(noticesService.postNoticesReadAll),
};
