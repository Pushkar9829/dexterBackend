const { handle } = require("../../utils/http");
const opsService = require("./ops.service");

module.exports = {
  getOpsMeta: handle(opsService.getOpsMeta),
  getOpsLiveAtms: handle(opsService.getOpsLiveAtms),
  getOpsDay: handle(opsService.getOpsDay),
  getOpsPrefill: handle(opsService.getOpsPrefill),
  postOpsEodVerifyDay: handle(opsService.postOpsEodVerifyDay),
  getOpsTxn: handle(opsService.getOpsTxn),
  putOpsTxn: handle(opsService.putOpsTxn),
  postOpsTxnConfirm: handle(opsService.postOpsTxnConfirm),
  getOpsTxnExport: handle(opsService.getOpsTxnExport),
  getOpsCbr1: handle(opsService.getOpsCbr1),
  putOpsCbr1: handle(opsService.putOpsCbr1),
  getOpsCbr2: handle(opsService.getOpsCbr2),
  putOpsCbr2: handle(opsService.putOpsCbr2),
  getOpsFunding: handle(opsService.getOpsFunding),
  putOpsFunding: handle(opsService.putOpsFunding),
  patchOpsFundingByIdCorrect: handle(opsService.patchOpsFundingByIdCorrect),
  getOpsEod: handle(opsService.getOpsEod),
  putOpsEod: handle(opsService.putOpsEod),
  postOpsEodByIdSubmit: handle(opsService.postOpsEodByIdSubmit),
  postOpsEodByIdVerify: handle(opsService.postOpsEodByIdVerify),
  patchOpsEodByIdAdminCorrect: handle(opsService.patchOpsEodByIdAdminCorrect),
  getOpsOverage: handle(opsService.getOpsOverage),
  postOpsOverage: handle(opsService.postOpsOverage),
};
