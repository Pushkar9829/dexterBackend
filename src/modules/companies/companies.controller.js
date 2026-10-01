const { handle } = require("../../utils/http");
const companiesService = require("./companies.service");

module.exports = {
  getCompanies: handle(companiesService.getCompanies),
  postCompanies: handle(companiesService.postCompanies),
  patchCompaniesById: handle(companiesService.patchCompaniesById),
  patchCompaniesByIdSecurity: handle(companiesService.patchCompaniesByIdSecurity),
  postCompanyMove: handle(companiesService.postCompanyMove),
};
