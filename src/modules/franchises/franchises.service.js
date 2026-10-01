const { can, companyScope, isFieldStaff, isOfficeAdmin } = require("../../middlewares/rbac");
const { FRANCHISE_FIELDS, OWNERSHIP_TYPES, FRANCHISE_STATUSES } = require("./franchises.model");
const repo = require("./franchises.repository");
const { endSessionLog } = require("../audit/audit.service");
const { writeAudit } = require("../../utils/audit-writer");

const BLOCKED_STATUSES = ["Suspended", "Closed"];
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, FRANCHISE_LAYERS, inFranchiseScope } = require("../../utils/scope");

function franchiseFields(body) {
  const set = {};
  for (const k of FRANCHISE_FIELDS) if (body[k] !== undefined) set[k] = String(body[k] || "").trim();
  if (set.gstin) set.gstin = set.gstin.toUpperCase();
  if (set.ifsc) set.ifsc = set.ifsc.toUpperCase();
  if (set.pan) set.pan = set.pan.toUpperCase();
  if (set.altEmail) set.altEmail = set.altEmail.toLowerCase();
  if (set.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(set.pan)) return { error: "PAN must look like ABCDE1234F" };
  for (const k of ["whatsapp", "altMobile"]) if (set[k] && !/^\d{10}$/.test(set[k])) return { error: (k === "whatsapp" ? "WhatsApp" : "alternate mobile") + " must be 10 digits" };
  if (set.altEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set.altEmail)) return { error: "alternate email not valid" };
  if (set.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(set.gstin)) return { error: "GSTIN must look like 23ABCDE1234F1Z5" };
  if (set.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(set.ifsc)) return { error: "IFSC must look like ABCD0123456" };
  if (set.mobile && !/^\d{10}$/.test(set.mobile)) return { error: "mobile must be 10 digits" };
  if (set.pin && !/^\d{6}$/.test(set.pin)) return { error: "PIN must be 6 digits" };
  if (set.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set.email)) return { error: "email not valid" };
  if (set.ownershipType !== undefined && !OWNERSHIP_TYPES.includes(set.ownershipType)) return { error: "ownership must be " + OWNERSHIP_TYPES.filter(Boolean).join(" / ") };
  return { set };
}

async function franchiseKyc(companyId, list) {
  if (!list.length) return;
  const apps = await repo.applications.list({ companyId, franchiseId: { $in: list.map((f) => f._id) } }, { projection: { _id: 1, franchiseId: 1 } });
  const kyc = apps.length
    ? await repo.documents.list({ parentType: "application", parentId: { $in: apps.map((a) => a._id) } }, { projection: { parentId: 1, verificationStatus: 1 } })
    : [];
  for (const f of list) {
    const ids = new Set(apps.filter((a) => String(a.franchiseId) === String(f._id)).map((a) => String(a._id)));
    const st = kyc.filter((k) => ids.has(String(k.parentId))).map((k) => k.verificationStatus);
    f.kycStatus = !st.length ? "Not started" : st.includes("KYC Rejected") ? "Rejected" : st.every((s) => s === "KYC Verified") ? "Verified" : "Pending";
  }
}

async function getFranchises(ctx) {
  const companyId = oid(ctx.query.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const filter = { companyId };
  await applyFranchiseFilter(ctx.user, filter, "_id");
  const list = await repo.franchises.list(filter, { sort: { name: 1 } });
  await franchiseKyc(companyId, list);
  return { status: 200, body: { franchises: list } };
}

async function postFranchises(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const companyId = oid(ctx.body.companyId || ctx.user.companyId);
  if (!companyId || !companyScope(ctx.user, companyId)) return { status: 403, body: { error: "company scope" } };
  const layer = String(ctx.body.layer || "Franchise");
  if (!FRANCHISE_LAYERS.includes(layer)) return { status: 400, body: { error: "unknown layer" } };
  const p = await treeParents(companyId, layer, ctx.body.superMasterId, ctx.body.masterId);
  if (p.error) return { status: 400, body: { error: p.error } };
  const doc = {
    companyId,
    name: String(ctx.body.name || "").trim(),
    status: String(ctx.body.status || "Under Process"),
    layer,
    superMasterId: p.superMasterId,
    masterId: p.masterId,
    createdAt: new Date(),
  };
  if (!doc.name) return { status: 400, body: { error: "name required" } };
  if (!FRANCHISE_STATUSES.includes(doc.status)) return { status: 400, body: { error: "status must be " + FRANCHISE_STATUSES.join(" / ") } };
  const ff = franchiseFields(ctx.body);
  if (ff.error) return { status: 400, body: { error: ff.error } };
  Object.assign(doc, ff.set);
  const result = await repo.franchises.insert(doc);
  await writeAudit(ctx, "FranchiseCreated", { companyId, module: "CRM-02", recordId: result.insertedId, after: doc });
  return { status: 200, body: { id: String(result.insertedId) } };
}

async function treeParents(companyId, layer, superMasterId, masterId, selfId) {
  const load = async (id, want) => {
    if (!id) return null;
    const n = await repo.franchises.findOne({ _id: oid(id), companyId });
    if (!n || n.layer !== want) throw new Error((want === "MasterFranchise" ? "Master" : "Super Master") + " not found in this company");
    if (selfId && String(n._id) === String(selfId)) throw new Error("a node cannot sit under itself");
    return n;
  };
  try {
    if (layer === "SuperMasterFranchise") return { superMasterId: null, masterId: null };
    const master = layer === "Franchise" ? await load(masterId, "MasterFranchise") : null;
    const sm = await load(superMasterId || (master && master.superMasterId), "SuperMasterFranchise");
    if (master && sm && String(master.superMasterId || "") !== String(sm._id)) throw new Error("that Master is not under that Super Master");
    return { superMasterId: sm ? sm._id : null, masterId: master ? master._id : null };
  } catch (e) {
    return { error: e.message };
  }
}

async function patchFranchisesById(ctx) {
  if (!isOfficeAdmin(ctx.user)) return { status: 403, body: { error: "not allowed" } };
  const row = await repo.franchises.findById(oid(ctx.params.id));
  if (!row || !companyScope(ctx.user, row.companyId)) return { status: 404, body: { error: "not found" } };
  const set = {};
  if (ctx.body.name !== undefined) {
    set.name = String(ctx.body.name).trim();
    if (!set.name) return { status: 400, body: { error: "name required" } };
  }
  if (ctx.body.status !== undefined) {
    if (!FRANCHISE_STATUSES.includes(ctx.body.status)) return { status: 400, body: { error: "status must be " + FRANCHISE_STATUSES.join(" / ") } };
    set.status = ctx.body.status;
  }
  const ff = franchiseFields(ctx.body);
  if (ff.error) return { status: 400, body: { error: ff.error } };
  Object.assign(set, ff.set);
  const moving = ctx.body.superMasterId !== undefined || ctx.body.masterId !== undefined;
  if (moving) {
    // A new Master alone brings its own Super Master; only an explicit Super Master pick is checked against it.
    const superPick = ctx.body.superMasterId !== undefined ? ctx.body.superMasterId : ctx.body.masterId ? null : row.superMasterId;
    const p = await treeParents(row.companyId, row.layer, superPick, ctx.body.masterId !== undefined ? ctx.body.masterId : row.masterId, row._id);
    if (p.error) return { status: 400, body: { error: p.error } };
    set.superMasterId = p.superMasterId;
    set.masterId = p.masterId;
  }
  if (!Object.keys(set).length) return { status: 200, body: { ok: true } };
  await repo.franchises.updateById(row._id, { $set: { ...set, updatedAt: new Date() } });
  if (moving && row.layer === "MasterFranchise") await repo.franchises.updateMany({ companyId: row.companyId, masterId: row._id }, { $set: { superMasterId: set.superMasterId } });
  const before = {};
  Object.keys(set).forEach((k) => (before[k] = row[k] === undefined ? null : row[k]));
  await writeAudit(ctx, moving ? "FranchiseMoved" : "FranchiseUpdated", { companyId: row.companyId, module: "CRM-02", recordId: row._id, before, after: set });
  let loggedOut = 0;
  if (set.status && set.status !== (row.status || "Active")) {
    const blocked = BLOCKED_STATUSES.includes(set.status);
    const { notifyFranchise, companyAdmins, notify } = require("../notices/notices.service");
    const link = { page: "fr360", id: String(row._id) };
    await notifyFranchise(row.companyId, row._id, {
      kind: "franchise",
      title: row.name + " is now " + set.status,
      body: blocked ? "Logins of this franchise are blocked until the office reactivates it." : "Changed by " + (ctx.user.name || ctx.user.login),
      link,
    });
    if (blocked) {
      const users = await repo.users.list({ companyId: row.companyId, franchiseId: row._id, hierarchy: { $in: FRANCHISE_LAYERS } }, { projection: { _id: 1 } });
      const ids = users.map((u) => u._id);
      if (ids.length) {
        loggedOut = (await repo.sessions.deleteMany({ userId: { $in: ids } })).deletedCount || 0;
        for (const id of ids) await endSessionLog({ userId: id }, "Revoked");
      }
    }
    const admins = (await companyAdmins(row.companyId)).filter((id) => String(id) !== String(ctx.user._id));
    await notify(row.companyId, admins, { kind: "franchise", title: "Franchise " + row.name + ": " + (row.status || "Active") + " → " + set.status, body: "By " + (ctx.user.name || ctx.user.login) + (loggedOut ? " · " + loggedOut + " session(s) ended" : ""), link });
  }
  return { status: 200, body: { ok: true, loggedOut } };
}

const maskAcct = (n) => (n ? "••••" + String(n).slice(-4) : n);

async function getFranchise360ById(ctx) {
  if (isFieldStaff(ctx.user)) return { status: 403, body: { error: "not available to field staff" } };
  const id = oid(ctx.params.id);
  const fr = id ? await repo.franchises.findById(id) : null;
  if (!fr || !companyScope(ctx.user, fr.companyId)) return { status: 404, body: { error: "not found" } };
  if (!(await inFranchiseScope(ctx.user, id))) return { status: 403, body: { error: "own records only" } };
  const scope = { companyId: fr.companyId, franchiseId: id };
  const recent = { sort: { createdAt: -1 }, limit: 200 };
  const [sites, atms, applications, lois, agreements] = await Promise.all([
    repo.sites.list(scope),
    repo.atms.list(scope),
    repo.applications.list(scope, { projection: { history: 0 } }),
    repo.lois.list(scope),
    repo.agreements.list(scope),
  ]);
  const documents = await repo.documents.list({ companyId: fr.companyId, parentId: { $in: applications.map((a) => a._id).concat([id]) } }, { projection: { data: 0 } });
  await franchiseKyc(fr.companyId, [fr]);
  fr.accountNumber = maskAcct(fr.accountNumber);
  if (fr.payoutAccount) fr.payoutAccount = { ...fr.payoutAccount, accountNumber: maskAcct(fr.payoutAccount.accountNumber) };
  const body = { franchise: fr, sites, atms, applications, documents, lois, agreements, sections: ["sites", "atms", "applications", "documents", "lois", "agreements"] };
  const atmIds = atms.map((a) => a.atmId);

  if (can(ctx.user, "View", "CRM-03")) {
    const today = new Date().toISOString().slice(0, 10);
    body.projects = (await repo.collection("site_projects").find(scope).project({ stages: 1, projectName: 1, atmId: 1, held: 1, heldReason: 1, completedAt: 1, techLiveDate: 1, cashLiveDate: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(100).toArray()).map((p) => {
      const stages = p.stages || [];
      const current = stages.find((s) => !s.approvedAt);
      return {
        _id: p._id,
        projectName: p.projectName,
        atmId: p.atmId || "",
        status: p.completedAt ? "Completed" : p.held ? "Held" : "Active",
        currentStage: current ? current.name : "—",
        stageDue: current ? current.dueDate || "" : "",
        delayed: !p.completedAt && !p.held && stages.some((s) => !s.approvedAt && s.dueDate && s.dueDate < today),
        progress: stages.length ? Math.round((stages.filter((s) => s.approvedAt).length / stages.length) * 100) + "%" : "",
        techLiveDate: p.techLiveDate,
        cashLiveDate: p.cashLiveDate,
        heldReason: p.heldReason || "",
      };
    });
    body.sections.push("projects");
  }

  if (can(ctx.user, "View", "CRM-05")) {
    body.complaints = atmIds.length
      ? await repo.complaints.list({ companyId: fr.companyId, atmId: { $in: atmIds } }, { projection: { history: 0, attachments: 0 }, ...recent })
      : [];
    body.sections.push("complaints");
    const mails = await repo.collection("mails").find({ companyId: fr.companyId, status: { $ne: "Draft" }, $or: [{ franchiseId: id }, ...(atmIds.length ? [{ atmId: { $in: atmIds } }] : [])] }).project({ body: 0, attachments: 0, references: 0 }).sort({ createdAt: -1 }).limit(150).toArray();
    body.communications = mails.map((m) => ({ _id: m._id, complaintId: m.complaintId || null, date: m.receivedAt || m.sentAt || m.createdAt, way: m.direction === "in" ? "Received" : "Sent", subject: m.subject || "", from: m.from || m.createdByName || "", to: (m.to || []).join(", "), docketNumber: m.docketNumber || "", status: m.status || "", auto: m.auto ? "Auto" : "" }));
    body.sections.push("communications");
  }

  if (can(ctx.user, "View", "CRM-04") && atmIds.length) {
    const TXN = ["nonCash", "cash", "upi", "deposit"];
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const month = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
    const rows = await repo.collection("ops_txn").find({ companyId: fr.companyId, atmId: { $in: atmIds }, date: { $gte: since < month + "-01" ? since : month + "-01" } }).toArray();
    const total = (r, k) => TXN.reduce((s, t) => s + (Number(r[t + k]) || 0), 0);
    body.txnSummary = atms.map((a) => {
      const mine = rows.filter((r) => r.atmId === a.atmId);
      const last30 = mine.filter((r) => r.date >= since);
      const mtd = mine.filter((r) => r.date >= month + "-01");
      const count30 = last30.reduce((s, r) => s + total(r, "Count"), 0);
      return {
        atmId: a.atmId,
        status: a.status || "",
        lastEntry: mine.reduce((m, r) => (r.date > m ? r.date : m), ""),
        daysEntered30: last30.length,
        txnCount30: count30,
        avgDailyCount: Math.round(count30 / (last30.length || 1)),
        amount30: Math.round(last30.reduce((s, r) => s + total(r, "Amount"), 0)),
        mtdCount: mtd.reduce((s, r) => s + total(r, "Count"), 0),
        mtdAmount: Math.round(mtd.reduce((s, r) => s + total(r, "Amount"), 0)),
        zeroDays30: last30.filter((r) => !total(r, "Count")).length,
      };
    });
    body.sections.push("txnSummary");
  }
  if (can(ctx.user, "View", "CRM-04")) {
    const [securityDeposits, payments, gstBills, payouts, chargebacks, bankStatements, tdsLetters, payoutAccounts] = await Promise.all([
      repo.security_deposits.list(scope, recent),
      repo.payments.list(scope, recent),
      repo.gst_bills.list(scope, { sort: { month: -1 }, limit: 60 }),
      repo.payouts.list(scope, { sort: { month: -1 }, limit: 60 }),
      repo.chargebacks.list(scope, recent),
      repo.bank_statements.list(scope, { projection: { data: 0 }, sort: { month: -1 }, limit: 60 }),
      repo.tds_letters.list(scope, { projection: { data: 0 }, sort: { fy: -1, quarter: -1 }, limit: 40 }),
      repo.payout_accounts.list(scope),
    ]);
    Object.assign(body, {
      securityDeposits,
      payments,
      gstBills,
      payouts,
      chargebacks,
      bankStatements,
      tdsLetters,
      payoutAccounts: payoutAccounts.map((a) => ({ ...a, accountNumber: maskAcct(a.accountNumber) })),
    });
    const sum = (rows, k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
    body.money = {
      sdDue: sum(securityDeposits, "amountDue"),
      sdBalance: sum(securityDeposits, "balance"),
      paymentsPending: payments.filter((p) => ["Submitted", "Approved"].includes(p.status)).length,
      gstOpen: gstBills.filter((g) => g.status !== "Completed").length,
      payoutsPaid: sum(payouts.filter((p) => p.status === "Paid").map((p) => ({ v: p.netAmount === undefined ? p.amount : p.netAmount })), "v"),
      cbOpen: chargebacks.filter((c) => ["Open", "Under Review"].includes(c.status)).length,
      cbAmount: sum(chargebacks.filter((c) => c.status !== "Rejected"), "disputeAmount"),
      bsQuery: bankStatements.filter((b) => b.financeStatus === "Query").length,
    };
    body.sections.push("securityDeposits", "payments", "gstBills", "payouts", "chargebacks", "bankStatements", "tdsLetters", "payoutAccounts");
  }
  return { status: 200, body };
}

module.exports = { franchiseFields, franchiseKyc, treeParents, getFranchises, postFranchises, patchFranchisesById, getFranchise360ById };
