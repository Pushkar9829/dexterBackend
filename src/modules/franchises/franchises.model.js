const COLLECTIONS = ["agreements","applications","atms","bank_statements","chargebacks","complaints","documents","franchises","gst_bills","lois","payments","payout_accounts","payouts","security_deposits","sessions","sites","tds_letters","users"];

const FRANCHISE_STATUSES = ["Active", "Inactive", "Under Process", "Suspended", "Closed"];

const OWNERSHIP_TYPES = ["", "Proprietor", "Partnership", "Company", "LLP"];

const FRANCHISE_FIELDS = ["gstin", "bankName", "accountNumber", "ifsc", "accountHolder", "contactName", "mobile", "email", "address", "city", "state", "pin", "ownerName", "ownershipType", "partners", "pan", "panName", "whatsapp", "altMobile", "altEmail", "circle"];

module.exports = { COLLECTIONS, FRANCHISE_STATUSES, OWNERSHIP_TYPES, FRANCHISE_FIELDS };
