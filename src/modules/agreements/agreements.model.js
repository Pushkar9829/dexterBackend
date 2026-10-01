const COLLECTIONS = ["agreements","franchises","lookups","register_columns"];

const LIFECYCLES = ["Draft", "Active", "Expiring Soon", "Renewal Due", "Expired", "Renewed", "Terminated"];

const TERM_TEXT = ["agreementNo", "paymentTerms", "payoutTerms", "penaltyClause"];

function shift(ymd, days) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Lifecycle is derived from the approval status and dates so it never goes stale. A later approved agreement on the same
// application marks the earlier one Renewed.
function lifecycle(g, all, today, renewDays) {
  if (g.status === "Terminated") return "Terminated";
  if (g.status !== "Approved") return "Draft";
  const successor = all.some((o) => String(o._id) !== String(g._id) && o.status === "Approved" && String(o.applicationId || "") === String(g.applicationId || "") && new Date(o.createdAt) > new Date(g.createdAt));
  if (successor) return "Renewed";
  if (!g.endDate) return "Active";
  if (g.endDate < today) return "Expired";
  if ((g.renewalDate || shift(g.endDate, -renewDays)) <= today) return "Renewal Due";
  if (shift(g.endDate, -90) <= today) return "Expiring Soon";
  return "Active";
}

module.exports = { COLLECTIONS, LIFECYCLES, TERM_TEXT, lifecycle };
