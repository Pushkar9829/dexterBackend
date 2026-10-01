const { handle } = require("../../utils/http");
const usersService = require("./users.service");

module.exports = {
  getUsers: handle(usersService.getUsers),
  postUsers: handle(usersService.postUsers),
  patchUsersByIdActivate: handle(usersService.patchUsersByIdActivate),
  patchUsersByIdUnlock: handle(usersService.patchUsersByIdUnlock),
  postUsersByIdResetPassword: handle(usersService.postUsersByIdResetPassword),
  patchUsersById: handle(usersService.patchUsersById),
  getRoleTemplates: handle(usersService.getRoleTemplates),
  putRoleTemplates: handle(usersService.putRoleTemplates),
};
