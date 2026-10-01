const { handle } = require("../../utils/http");
const employeesService = require("./employees.service");

module.exports = {
  getEmployees: handle(employeesService.getEmployees),
  postEmployees: handle(employeesService.postEmployees),
  patchEmployeesById: handle(employeesService.patchEmployeesById),
};
