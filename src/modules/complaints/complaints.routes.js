const { Router } = require("express");
const controller = require("./complaints.controller");
const { requireAuth, requireAction } = require("../../middlewares/rbac");

const router = Router();

router.get("/api/service/meta", requireAuth, controller.getServiceMeta);
router.patch("/api/service/sla", requireAuth, controller.patchServiceSla);
router.patch("/api/service/settings", requireAuth, controller.patchServiceSettings);
router.get("/api/service/officers", requireAuth, controller.getServiceOfficers);
router.get("/api/service/board", requireAuth, requireAction("View", "CRM-05"), controller.getServiceBoard);
router.get("/api/complaints", requireAuth, requireAction("View", "CRM-05"), controller.getComplaints);
router.get("/api/complaints/:id", requireAuth, requireAction("View", "CRM-05"), controller.getComplaintsById);
router.post("/api/complaints", requireAuth, requireAction("Create", "CRM-05"), controller.postComplaints);
router.get("/api/complaints-export", requireAuth, requireAction("View", "CRM-05"), controller.getComplaintsExport);
router.patch("/api/complaints/:id", requireAuth, controller.patchComplaintsById);
router.post("/api/complaints/:id/visits", requireAuth, controller.postComplaintsByIdVisits);
router.get("/api/visits", requireAuth, requireAction("View", "CRM-05"), controller.getVisits);
router.patch("/api/visits/:id", requireAuth, controller.patchVisitsById);
router.get("/api/inspections", requireAuth, requireAction("View", "CRM-05"), controller.getInspections);
router.post("/api/inspections", requireAuth, requireAction("Create", "CRM-05"), controller.postInspections);
router.patch("/api/inspections/:id", requireAuth, controller.patchInspectionsById);
router.get("/api/service/atm-history/:atmId", requireAuth, requireAction("View", "CRM-05"), controller.getServiceAtmHistoryByAtmId);

module.exports = router;
