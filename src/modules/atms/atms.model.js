const COLLECTIONS = ["agreements","applications","atms","franchises","lois","projects","site_projects","sites"];

const ATM_TEXT_FIELDS = ["atmSerialNumber", "machineTypeModel", "model", "modelType", "atmType", "city", "state", "siteId", "region", "franchiseeName", "mobile", "email", "bankName", "loi", "agreement", "mdType", "email2", "salesOfficer", "hitachiCode", "sapCode", "solId"];

const FUNDING_PATHS = ["WLA", "Axis", "ICD"];

const ATM_STATUSES = ["Active", "Inactive", "Under Installation", "Under Maintenance", "Temporarily Down", "Suspended", "Decommissioned"];

// Stored status wins; ATMs saved before the field existed read as Active once Cash Live, otherwise Under Installation.
function atmStatus(a) {
  return (a && a.status) || (a && a.cashLiveDate ? "Active" : "Under Installation");
}

module.exports = { COLLECTIONS, ATM_TEXT_FIELDS, FUNDING_PATHS, ATM_STATUSES, atmStatus };
