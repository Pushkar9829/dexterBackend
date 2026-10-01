const { col } = require("./db");

// Indexes and one-off data backfills applied at every start. Each call is idempotent.
async function ensureIndexes() {
  await col("sessions").dropIndex("expiresAt_1").catch(() => {});
  await col("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
  await col("mfa_tickets").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await col("users")
    .createIndex({ login: 1 }, { unique: true })
    .catch((err) => console.warn("users.login unique index not created (duplicate logins exist?): " + err.message));

  await col("ops_txn").createIndex({ companyId: 1, atmId: 1, date: 1 }, { unique: true });
  await col("ops_cbr1").createIndex({ companyId: 1, atmId: 1, date: 1 }, { unique: true });
  await col("ops_cbr2").createIndex({ companyId: 1, atmId: 1, date: 1 }, { unique: true });
  await col("ops_funding").createIndex({ companyId: 1, atmId: 1, date: 1, type: 1 }, { unique: true });
  await col("ops_eod").createIndex({ companyId: 1, atmId: 1, date: 1 }, { unique: true });

  await col("complaints").createIndex({ companyId: 1, docketNumber: 1 }, { unique: true });
  await col("complaints").createIndex({ companyId: 1, openKey: 1 }, { unique: true, partialFilterExpression: { openKey: { $type: "string" } } });
  for (const c of await col("complaints").find({ status: { $nin: ["Resolved", "Closed"] }, openKey: { $exists: false } }).project({ atmId: 1, problemType: 1 }).toArray()) {
    await col("complaints").updateOne({ _id: c._id }, { $set: { openKey: c.atmId + "|" + c.problemType } }).catch(() => {});
  }
  await col("visits").updateMany({ open: { $exists: false } }, [{ $set: { open: { $in: ["$status", ["Scheduled", "Rescheduled", "CheckedIn"]] } } }]);
  await col("visits").createIndex({ complaintId: 1 }, { unique: true, partialFilterExpression: { open: true }, name: "one_open_visit" });
  await col("complaints").createIndex({ companyId: 1, atmId: 1, status: 1 });
  await col("visits").createIndex({ companyId: 1, complaintId: 1 });
  await col("inspections").createIndex({ companyId: 1, atmId: 1, date: 1, type: 1 }, { unique: true });

  await col("mails").createIndex({ companyId: 1, messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: "string" } } });
  await col("mails").createIndex({ companyId: 1, complaintId: 1, createdAt: -1 });
  await col("mails").createIndex({ companyId: 1, threadId: 1 });
  await col("mail_templates").createIndex({ companyId: 1, key: 1 }, { unique: true });
  await col("tracker_rows").createIndex({ companyId: 1, variant: 1, month: 1 });
  await col("audit_events").createIndex({ companyId: 1, at: -1 });
  await col("session_log").createIndex({ companyId: 1, startAt: -1 });
  await col("session_log").createIndex({ userId: 1, startAt: -1 });
  await col("payments").createIndex({ companyId: 1, txnNumber: 1 });
  await col("chargebacks").createIndex({ companyId: 1, atmId: 1, tlfRrn: 1 }, { unique: true });
  await col("security_deposits").createIndex({ companyId: 1, franchiseId: 1, label: 1 }, { unique: true });
  await col("bank_statements").createIndex({ companyId: 1, franchiseId: 1, month: 1 }, { unique: true });
  await col("tds_letters").createIndex({ companyId: 1, franchiseId: 1, fy: 1, quarter: 1 }, { unique: true });
  await col("gst_bills").createIndex({ companyId: 1, franchiseId: 1, month: 1 }, { unique: true });
  await col("payout_accounts").createIndex({ companyId: 1, franchiseId: 1 }, { unique: true });
  await col("payouts").createIndex({ companyId: 1, franchiseId: 1, month: 1 });
  await col("ops_monthly").createIndex({ companyId: 1, atmId: 1, month: 1 }, { unique: true });
  await col("ops_loading").createIndex({ companyId: 1, atmId: 1, date: 1 }, { unique: true });
  await col("tasks").createIndex({ companyId: 1, status: 1, dueAt: 1 });
  await col("tasks").createIndex({ companyId: 1, assigneeId: 1 });
  await col("tasks").createIndex({ companyId: 1, templateId: 1, instancePeriod: 1 }, { unique: true, partialFilterExpression: { templateId: { $type: "objectId" } } });
  await col("notices").createIndex({ userId: 1, read: 1, createdAt: -1 });
  await col("notices").createIndex({ companyId: 1, userId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });
}

module.exports = { ensureIndexes };
