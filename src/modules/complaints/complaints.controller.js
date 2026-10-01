const { handle } = require("../../utils/http");
const complaintsService = require("./complaints.service");

module.exports = {
  getServiceMeta: handle(complaintsService.getServiceMeta),
  getServiceBoard: handle(complaintsService.getServiceBoard),
  patchServiceSla: handle(complaintsService.patchServiceSla),
  patchServiceSettings: handle(complaintsService.patchServiceSettings),
  getServiceOfficers: handle(complaintsService.getServiceOfficers),
  getComplaints: handle(complaintsService.getComplaints),
  getComplaintsById: handle(complaintsService.getComplaintsById),
  postComplaints: handle(complaintsService.postComplaints),
  getComplaintsExport: handle(complaintsService.getComplaintsExport),
  patchComplaintsById: handle(complaintsService.patchComplaintsById),
  postComplaintsByIdVisits: handle(complaintsService.postComplaintsByIdVisits),
  getVisits: handle(complaintsService.getVisits),
  patchVisitsById: handle(complaintsService.patchVisitsById),
  getInspections: handle(complaintsService.getInspections),
  postInspections: handle(complaintsService.postInspections),
  patchInspectionsById: handle(complaintsService.patchInspectionsById),
  getServiceAtmHistoryByAtmId: handle(complaintsService.getServiceAtmHistoryByAtmId),
};
