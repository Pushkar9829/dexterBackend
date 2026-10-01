const { Router } = require("express");
const controller = require("./tasks.controller");
const { requireAuth, isFranchiseNetwork } = require("../../middlewares/rbac");

const router = Router();

function officeOnly(req, res, next) {
  if (isFranchiseNetwork(req.user)) return res.status(403).json({ error: "tasks are for office users only" });
  next();
}

router.get("/api/tasks/meta", requireAuth, officeOnly, controller.getTasksMeta);
router.get("/api/tasks/assignees", requireAuth, officeOnly, controller.getTasksAssignees);
router.patch("/api/tasks/profile/:userId", requireAuth, officeOnly, controller.patchTasksProfileByUserId);
router.patch("/api/tasks/settings", requireAuth, officeOnly, controller.patchTasksSettings);
router.get("/api/tasks", requireAuth, officeOnly, controller.getTasks);
router.get("/api/tasks/export", requireAuth, officeOnly, controller.getTasksExport);
router.get("/api/tasks/workload", requireAuth, officeOnly, controller.getTasksWorkload);
router.get("/api/tasks/:id", requireAuth, officeOnly, controller.getTasksById);
router.post("/api/tasks/:id/files", requireAuth, officeOnly, controller.postTasksByIdFiles);
router.post("/api/tasks", requireAuth, officeOnly, controller.postTasks);
router.patch("/api/tasks/:id", requireAuth, officeOnly, controller.patchTasksById);
router.get("/api/task-templates", requireAuth, officeOnly, controller.getTaskTemplates);
router.post("/api/task-templates", requireAuth, officeOnly, controller.postTaskTemplates);
router.patch("/api/task-templates/:id", requireAuth, officeOnly, controller.patchTaskTemplatesById);

module.exports = router;
