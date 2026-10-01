const { handle } = require("../../utils/http");
const importsService = require("./imports.service");

module.exports = {
  getImportsTemplates: handle(importsService.getImportsTemplates),
  postImports: handle(importsService.postImports),
  getImports: handle(importsService.getImports),
  getImportsByIdOriginal: handle(importsService.getImportsByIdOriginal),
  getImportsByIdErrors: handle(importsService.getImportsByIdErrors),
};
