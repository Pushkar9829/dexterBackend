const { handle } = require("../../utils/http");
const mailService = require("./mail.service");
const inboundHookService = require("./inbound-hook.service");

module.exports = {
  getMailMeta: handle(mailService.getMailMeta),
  postMailMailbox: handle(mailService.postMailMailbox),
  putMailTemplatesByKey: handle(mailService.putMailTemplatesByKey),
  putMailSignature: handle(mailService.putMailSignature),
  postMailRender: handle(mailService.postMailRender),
  getMail: handle(mailService.getMail),
  postMail: handle(mailService.postMail),
  patchMailById: handle(mailService.patchMailById),
  postMailInbound: handle(mailService.postMailInbound),
  patchMailByIdMap: handle(mailService.patchMailByIdMap),
  postMailByIdTicket: handle(mailService.postMailByIdTicket),
  postMailByIdReply: handle(mailService.postMailByIdReply),
  getMailTrackerByVariant: handle(mailService.getMailTrackerByVariant),
  postMailTrackerByVariant: handle(mailService.postMailTrackerByVariant),
  patchMailTrackerRowById: handle(mailService.patchMailTrackerRowById),
  postMailInboundHook: handle(inboundHookService.postMailInboundHook),
};
