const COLLECTIONS = ["applications","franchises","site_projects"];

const PHOTO_SLOTS = [
  "Front View of the shop",
  "Right view from ATM site",
  "Left view from ATM site",
  "Opposite view",
  "Right view from the road",
  "Left view from the road",
  "Internal view of the shop",
  "Complete view with shutter",
  "Terrace right view",
  "Terrace Left view",
  "Terrace opposite view",
  "Terrace Back view",
  "Terrace View (Space for V-SAT)",
  "Location from Google map",
  "Satellite view",
];

const APP_FIELDS = [
  "siteLocationName", "zone", "district", "pin", "landmark", "rbiCategory", "address", "lat", "lng",
  "siteType", "tisType", "projectType", "businessType", "model", "existingAtmId",
  "landlordName", "landlordChequeName", "contactNumber", "alternateNumber", "whatsappNumber", "email", "circle",
  "corrAddress", "corrLandmark", "corrDistrict", "corrState", "corrPin",
  "bankName", "branchName", "accountNumber", "ifsc",
  "totalShopArea", "shopAreaOffered", "carpetArea", "depth", "width", "height", "frontage",
  "vsat", "acOdu", "powerYes", "powerPermanent", "powerHours", "signageW", "signageH",
  "shopStatus", "shutter", "craCoverage", "craAgency", "proposedBranch", "bmName", "bmNumber",
  "solIfsc", "distanceKm", "state", "city",
  "siteNumber", "sourcedBy", "sourcingCode", "sseSsm",
  "franchiseId", "siteId", "applicantPhotoName", "signedByName", "signedDate",
  "lShapeSignage", "frontageOffered", "highwayNotes",
];

const ATM_GRID_COLS = ["atmId", "bank", "siteType", "distance", "direction", "avgTxn"];

const DOC_CHECKLIST = ["PAN", "Aadhaar", "Cancelled cheque", "Bank statement", "GST", "Business proof", "Rent agreement", "Shop photos", "Affidavit", "PPT"];

const SUBMIT_REQUIRED = [
  ["siteLocationName", "Site location name"],
  ["state", "State"],
  ["city", "City"],
  ["pin", "PIN"],
  ["address", "Full address"],
  ["siteType", "Site type"],
  ["model", "Model"],
  ["landlordName", "Landlord name"],
  ["contactNumber", "Contact number"],
];

const SUBMIT_DOCS = ["PAN", "Aadhaar"];

const FORMAT_RULES = [
  ["pin", /^\d{6}$/, "PIN must be 6 digits"],
  ["contactNumber", /^[6-9]\d{9}$/, "Contact number must be a 10-digit mobile"],
  ["alternateNumber", /^[6-9]\d{9}$/, "Alternate number must be a 10-digit mobile"],
  ["whatsappNumber", /^[6-9]\d{9}$/, "WhatsApp number must be a 10-digit mobile"],
  ["bmNumber", /^[6-9]\d{9}$/, "BM number must be a 10-digit mobile"],
  ["ifsc", /^[A-Z]{4}0[A-Z0-9]{6}$/i, "IFSC must look like ABCD0123456"],
  ["solIfsc", /^[A-Z]{4}0[A-Z0-9]{6}$/i, "SOL / IFSC must look like ABCD0123456"],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Email is not valid"],
  ["corrPin", /^\d{6}$/, "Correspondence PIN must be 6 digits"],
  ["accountNumber", /^\d{6,18}$/, "Account number must be 6–18 digits"],
];

module.exports = { COLLECTIONS, PHOTO_SLOTS, APP_FIELDS, ATM_GRID_COLS, DOC_CHECKLIST, SUBMIT_REQUIRED, SUBMIT_DOCS, FORMAT_RULES };
