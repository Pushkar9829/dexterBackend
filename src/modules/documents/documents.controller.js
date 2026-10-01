const { handle } = require("../../utils/http");
const documentsService = require("./documents.service");
const idCheckService = require("./id-check.service");

module.exports = {
  getDocuments: handle(documentsService.getDocuments),
  postDocuments: handle(documentsService.postDocuments),
  getDocumentsByIdFile: handle(documentsService.getDocumentsByIdFile),
  patchDocumentsByIdVerify: handle(documentsService.patchDocumentsByIdVerify),
  patchDocumentsByIdRemarks: handle(documentsService.patchDocumentsByIdRemarks),
  deleteDocumentsById: handle(documentsService.deleteDocumentsById),
  postDocumentsByIdIdCheck: handle(idCheckService.postDocumentsByIdIdCheck),
};
