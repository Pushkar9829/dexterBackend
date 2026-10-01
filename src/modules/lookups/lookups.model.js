const COLLECTIONS = ["applications","documents","lookups"];

const LOOKUP_SEED = {
  states: ["Madhya Pradesh", "Maharashtra", "Delhi", "Uttar Pradesh", "Rajasthan", "Gujarat"],
  cities: ["Bhopal", "Indore", "Mumbai", "Pune", "Jaipur"],
  zones: ["North", "South", "East", "West", "Central"],
  regions: ["MP West", "MP East", "Maharashtra", "North India"],
  teams: ["Field North", "Field South", "Service Desk", "Finance Desk"],
  districts: ["Bhopal", "Indore", "Ujjain", "Jabalpur", "Gwalior", "Mumbai", "Pune", "Jaipur"],
  productModels: ["Sapphire", "Topaz", "Emerald"],
  machineTypes: ["NCR", "Diebold", "Hyosung", "Other"],
  banks: ["Axis", "HDFC", "SBI", "ICICI", "Hitachi Payment"],
  documentTypes: ["PAN", "Aadhaar", "Cancelled cheque", "Bank statement", "GST", "Business proof", "Rent agreement", "Affidavit", "PPT", "Photo", "LOI", "Agreement", "Applicant photo", "Franchise signature"],
  agreementTypes: ["WLA Franchise", "Addendum"],
  rbiCategories: ["Tier 1", "Tier 2", "Tier 3", "Tier 4"],
  siteTypes: ["Full Shop", "Shop in Shop"],
  tisTypes: ["Full TIS", "SIS TIS", "NO TIS"],
};

module.exports = { COLLECTIONS, LOOKUP_SEED };
