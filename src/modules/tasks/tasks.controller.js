const { handle } = require("../../utils/http");
const tasksService = require("./tasks.service");

module.exports = {
  getTasksMeta: handle(tasksService.getTasksMeta),
  getTasksAssignees: handle(tasksService.getTasksAssignees),
  patchTasksProfileByUserId: handle(tasksService.patchTasksProfileByUserId),
  patchTasksSettings: handle(tasksService.patchTasksSettings),
  getTasks: handle(tasksService.getTasks),
  getTasksExport: handle(tasksService.getTasksExport),
  getTasksWorkload: handle(tasksService.getTasksWorkload),
  getTasksById: handle(tasksService.getTasksById),
  postTasksByIdFiles: handle(tasksService.postTasksByIdFiles),
  postTasks: handle(tasksService.postTasks),
  patchTasksById: handle(tasksService.patchTasksById),
  getTaskTemplates: handle(tasksService.getTaskTemplates),
  postTaskTemplates: handle(tasksService.postTaskTemplates),
  patchTaskTemplatesById: handle(tasksService.patchTaskTemplatesById),
};
