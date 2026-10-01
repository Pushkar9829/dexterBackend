// UAT pass — LLD 08 §8. Walks each checklist scenario through the API as the real role
// and writes docs/architecture/11-UAT-RUN.md. Fresh data every run (safe to rerun).
const fs = require("fs");
const path = require("path");

const B = process.env.API_URL || "http://127.0.0.1:4000";
const REPORT = path.join(__dirname, "..", "..", "..", "docs", "architecture", "11-UAT-RUN.md");
const FRONTEND = path.join(__dirname, "..", "..", "frontend", "src");

async function call(p, token, method = "GET", body) {
  const r = await fetch(B + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function login(l, p) {
  const a = await call("/api/auth/login", null, "POST", { login: l, password: p });
  if (!a.data.ticket) throw new Error("login failed " + l);
  const m = await call("/api/auth/mfa", null, "POST", { ticket: a.data.ticket, otp: a.data.otpDemo });
  if (!m.data.token) throw new Error("MFA failed " + l);
  return m.data.token;
}

const b64 = (s) => Buffer.from(s).toString("base64");
const istDay = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);

const scenarios = [];
let current = null;
function scenario(no, title) {
  current = { no, title, steps: [] };
  scenarios.push(current);
}
function step(name, ok, detail) {
  current.steps.push({ name, ok: !!ok, detail: ok ? "" : detail || "" });
  console.log((ok ? "PASS " : "FAIL ") + current.no + ". " + name + (ok || !detail ? "" : " — " + detail));
}

async function newUser(admin, body, password) {
  const r = await call("/api/users", admin, "POST", { password, ...body });
  if (r.status !== 200) throw new Error("user create " + body.login + " " + JSON.stringify(r.data));
  await call("/api/users/" + r.data.id + "/activate", admin, "PATCH");
  return r.data.id;
}

(async () => {
  const stamp = Date.now();
  const started = new Date();
  const D = istDay(-1);
  const month = D.slice(0, 7);
  const A = "UAT-" + stamp;

  const admin = await login("admin@demo.local", "Admin@123");
  const adminB = await login("admin-b@demo.local", "AdminB@123");
  const fran = await login("franchisee@demo.local", "Fran@123");
  const sm = await login("supermaster@demo.local", "Super@123");
  const dexter = await login("dexter@demo.local", "Dexter@123");
  const so = await login("so@demo.local", "Sales@123");
  const meA = (await call("/api/auth/me", admin)).data.user;
  const meB = (await call("/api/auth/me", adminB)).data.user;
  const franMe = (await call("/api/auth/me", fran)).data.user;
  const users = (await call("/api/users", admin)).data.users;
  const soId = users.find((u) => u.login === "so@demo.local")._id;

  const opLogin = "uat-op-" + stamp + "@demo.local";
  await newUser(admin, { login: opLogin, name: "UAT Operator " + stamp, hierarchy: "SubAdmin" }, "UatOp@12345");
  const op = await login(opLogin, "UatOp@12345");

  // 1
  scenario(1, "Tenant isolation retest (two companies)");
  const isoApp = await call("/api/applications", admin, "POST", { siteLocationName: "UAT Iso " + stamp, city: "Indore" });
  step("company A creates an application", isoApp.status === 200);
  step("company B list does not show it", !(await call("/api/applications", adminB)).data.applications.some((x) => x._id === isoApp.data.id));
  step("company B cannot edit it", (await call("/api/applications/" + isoApp.data.id, adminB, "PATCH", { city: "X" })).status === 403);
  step("company B cannot read company A audit", (await call("/api/audit?companyId=" + meA.companyId, adminB)).status === 403);
  step("company Admin cannot switch company", (await call("/api/auth/company", admin, "POST", { companyId: meB.companyId })).status === 403);
  await call("/api/auth/company", dexter, "POST", { companyId: meB.companyId });
  step("Dexter India switched to company B does not see company A rows", !(await call("/api/applications", dexter)).data.applications.some((x) => x._id === isoApp.data.id));
  await call("/api/auth/company", dexter, "POST", { companyId: meA.companyId });
  step("Dexter India back in company A sees it", (await call("/api/applications", dexter)).data.applications.some((x) => x._id === isoApp.data.id));

  // 2
  scenario(2, "MFA login and recovery");
  const mfaLogin = "uat-mfa-" + stamp + "@demo.local";
  await newUser(admin, { login: mfaLogin, name: "UAT MFA " + stamp, hierarchy: "SubAdmin" }, "UatOld@12345");
  const t = await call("/api/auth/login", null, "POST", { login: mfaLogin, password: "UatOld@12345" });
  step("password alone gives a ticket, not a session", t.status === 200 && !!t.data.ticket && !t.data.token);
  step("wrong one-time code refused", (await call("/api/auth/mfa", null, "POST", { ticket: t.data.ticket, otp: "000000" })).status === 401);
  const ok = await call("/api/auth/mfa", null, "POST", { ticket: t.data.ticket, otp: t.data.otpDemo });
  step("right code gives a session", ok.status === 200 && !!ok.data.token);
  const fg = await call("/api/auth/forgot", null, "POST", { login: mfaLogin });
  step("reset code cannot be used to log in", (await call("/api/auth/mfa", null, "POST", { ticket: fg.data.ticket, otp: fg.data.otpDemo })).status === 401);
  step("password reset with code", (await call("/api/auth/reset", null, "POST", { ticket: fg.data.ticket, otp: fg.data.otpDemo, password: "UatNew@12345" })).status === 200);
  step("old password refused after reset", (await call("/api/auth/login", null, "POST", { login: mfaLogin, password: "UatOld@12345" })).status === 401);
  step("new password + MFA logs in", !!(await login(mfaLogin, "UatNew@12345").catch(() => null)));
  step("old session ended by the reset", (await call("/api/auth/me", ok.data.token)).status === 401);

  // 3
  scenario(3, "Hierarchy: Super Master sees child franchise; sibling does not");
  const frs = (await call("/api/franchises", admin)).data.franchises;
  const master = frs.find((f) => f.layer === "MasterFranchise" && f.name === "Master Indore");
  const sibNode = await call("/api/franchises", admin, "POST", { name: "UAT Sibling " + stamp, layer: "Franchise", superMasterId: master.superMasterId, masterId: master._id });
  const sibLogin = "uat-sib-" + stamp + "@demo.local";
  await newUser(admin, { login: sibLogin, name: "UAT Sibling " + stamp, hierarchy: "Franchise", franchiseId: sibNode.data.id }, "UatSib@12345");
  const sib = await login(sibLogin, "UatSib@12345");
  const childApp = await call("/api/applications", fran, "POST", { siteLocationName: "UAT Child " + stamp, city: "Indore" });
  const sibApp = await call("/api/applications", sib, "POST", { siteLocationName: "UAT Sib " + stamp, city: "Indore" });
  const smList = (await call("/api/applications", sm)).data.applications;
  step("Super Master sees the child franchise's application", smList.some((x) => x._id === childApp.data.id));
  step("Super Master sees the sibling's application (both under it)", smList.some((x) => x._id === sibApp.data.id));
  step("sibling franchise does not see Demo Franchisee's application", !(await call("/api/applications", sib)).data.applications.some((x) => x._id === childApp.data.id));
  step("Demo Franchisee does not see the sibling's application", !(await call("/api/applications", fran)).data.applications.some((x) => x._id === sibApp.data.id));
  step("sibling cannot edit Demo Franchisee's application", (await call("/api/applications/" + childApp.data.id, sib, "PATCH", { city: "X" })).status === 403);
  step("sibling cannot open Demo Franchisee's 360", (await call("/api/franchise-360/" + franMe.franchiseId, sib)).status === 403);

  // 4
  scenario(4, "Application → KYC → Link Shared → ATM master serial / machine type");
  const app = await call("/api/applications", fran, "POST", { siteLocationName: "UAT Site " + stamp, city: "Indore", model: "Sapphire" });
  const appId = app.data.id;
  step("franchisee files application", app.status === 200);
  const kyc = await call("/api/documents", fran, "POST", { parentId: appId, type: "PAN", fileName: "pan.txt", mime: "text/plain", data: b64("pan") });
  step("franchisee uploads KYC", kyc.status === 200);
  step("franchisee submits", (await call("/api/applications/" + appId, fran, "PATCH", { submit: true })).status === 200);
  step("office verifies KYC", (await call("/api/documents/" + kyc.data.id + "/verify", admin, "PATCH", { approve: true })).status === 200);
  step("office approves application", (await call("/api/applications/" + appId, admin, "PATCH", { approve: true })).status === 200);
  const loi = await call("/api/lois", admin, "POST", { loiCode: "UAT-" + stamp, applicationId: appId });
  step("LOI approved", (await call("/api/lois/" + loi.data.id, admin, "PATCH", { approve: true })).status === 200);
  const agr = await call("/api/agreements", admin, "POST", { applicationId: appId });
  step("franchisee cannot set Link Shared", (await call("/api/agreements/" + agr.data.id, fran, "PATCH", { status: "Link Shared" })).status === 403);
  step("office sets agreement Link Shared", (await call("/api/agreements/" + agr.data.id, admin, "PATCH", { status: "Link Shared" })).status === 200);
  step("ATM without serial / machine type refused", (await call("/api/atms", admin, "POST", { atmId: A })).status === 400);
  step("ATM Master row with serial and machine type", (await call("/api/atms", admin, "POST", { atmId: A, atmSerialNumber: "SN-" + stamp, machineTypeModel: "NCR 6622" })).status === 200);

  // 5
  scenario(5, "Project to Cash Live with evidence");
  const proj = await call("/api/site-projects", admin, "POST", { applicationId: appId });
  const pid = proj.data.id;
  step("project created from approved site", proj.status === 200);
  const meta = (await call("/api/site-projects/meta", admin)).data;
  await call("/api/site-projects/" + pid + "/stages/0/approve", admin, "POST", {});
  step("stage without evidence cannot be approved", (await call("/api/site-projects/" + pid + "/stages/1/approve", admin, "POST", {})).status === 400);
  step(
    "franchisee uploads stage evidence with GPS",
    (await call("/api/documents", fran, "POST", { parentType: "project", parentId: pid, type: "Stage: " + meta.stages[1], fileName: "tis.jpg", data: b64("img"), lat: "22.7", lng: "75.8", capturedAt: new Date().toISOString() })).status === 200
  );
  let stagesOk = (await call("/api/site-projects/" + pid + "/stages/1/approve", admin, "POST", {})).status === 200;
  for (let i = 2; i <= 8; i++) {
    await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: " + meta.stages[i], fileName: "e.jpg", data: b64("e") });
    stagesOk = stagesOk && (await call("/api/site-projects/" + pid + "/stages/" + i + "/approve", admin, "POST", {})).status === 200;
  }
  step("stages approved in order with evidence", stagesOk);
  await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: " + meta.stages[9], fileName: "e.jpg", data: b64("e") });
  step("Tech Live set with date", (await call("/api/site-projects/" + pid + "/stages/9/approve", admin, "POST", { date: D })).status === 200);
  await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: " + meta.stages[10], fileName: "e.jpg", data: b64("e") });
  step("Cash Live needs a linked ATM", (await call("/api/site-projects/" + pid + "/stages/10/approve", admin, "POST", { date: D })).status === 400);
  await call("/api/site-projects/" + pid, admin, "PATCH", { atmId: A });
  step("Cash Live approved", (await call("/api/site-projects/" + pid + "/stages/10/approve", admin, "POST", { date: D })).status === 200);
  const atmRow = (await call("/api/atms", admin)).data.atms.find((a) => a.atmId === A);
  step("Cash Live date written to ATM Master", atmRow && String(atmRow.cashLiveDate || "").startsWith(D));
  await call("/api/site-projects/" + pid + "/stages/11/approve", admin, "POST", {});
  const done = (await call("/api/site-projects/" + pid, fran)).data.project;
  step("franchisee sees project Completed at 100%", done && done.view === "Completed" && done.progress === 100);

  // 6
  scenario(6, "Import CBR 1 sample; EOD 23:00 lock; Admin-only wrong calc");
  const cbrCsv = ["atmId,date,deno,openingNotes,openingAmount,dispensedNotes,dispensedAmount", A + "," + D + ",500,1000,500000,60,30000", A + "," + D + ",100,10,5000,0,0"].join("\n");
  const imp = await call("/api/imports", admin, "POST", { template: "CBR-1", fileName: "cbr1-sample.csv", csv: cbrCsv });
  step("CBR 1 sample import: good line in, wrong notes × deno line out", imp.status === 200 && imp.data.batch.accepted === 1 && imp.data.batch.rejected === 1, JSON.stringify(imp.data.batch || imp.data));
  const errs = await call("/api/imports/" + (imp.data.batch || {})._id + "/errors", admin);
  step("error file names the bad line", errs.status === 200 && errs.data.csv.includes("3,"));
  step("TXN entered for the day", (await call("/api/ops/txn", admin, "PUT", { atmId: A, date: D, cashCount: 12, cashAmount: 30000 })).status === 200);
  await call("/api/ops/funding", admin, "PUT", { type: "Axis", atmId: A, date: D, lastDayDispenseApna: 30000, axisLot1: 100000, axisLot2: 0, loadingCbr: 90000 });
  const fundA = (await call("/api/ops/funding?date=" + D, admin)).data.rows.find((r) => r.atmId === A && r.type === "Axis");
  step("wrong indent calculation flagged for Admin", fundA && fundA.calcMismatch === true);
  const fundF = (await call("/api/ops/funding?date=" + D, fran)).data.rows.find((r) => r.atmId === A && r.type === "Axis");
  step("franchisee does not see the wrong-calc flag", fundF && fundF.calcMismatch === undefined);
  step("only Admin can correct it", (await call("/api/ops/funding/" + fundA._id + "/correct", op, "PATCH", { reason: "x" })).status === 403);
  step("Admin corrects with reason and the flag clears", (await call("/api/ops/funding/" + fundA._id + "/correct", admin, "PATCH", { reason: "UAT loading keyed short", loadingCbr: 100000 })).status === 200);
  const eod = await call("/api/ops/eod", op, "PUT", { atmId: A, date: D, eodTime: "23:00", opening: 500000, dispenseMachine: 30000, dispenseApna: 30000, physicalNotes: { 500: 940 } });
  step("operator saves 23:00 EOD", eod.status === 200 && eod.data.closing === 470000, JSON.stringify(eod.data));
  const eodRow = (await call("/api/ops/eod?date=" + D, admin)).data.rows.find((r) => r.atmId === A);
  step("EOD stamped 23:00", eodRow && eodRow.eodTime === "23:00");
  await call("/api/ops/eod/" + eodRow._id + "/submit", op, "POST", {});
  step("submitter cannot verify own EOD", (await call("/api/ops/eod/" + eodRow._id + "/verify", op, "POST", {})).status === 403);
  step("Admin verifies and locks", (await call("/api/ops/eod/" + eodRow._id + "/verify", admin, "POST", {})).status === 200);
  step("locked day refuses operator TXN edit", (await call("/api/ops/txn", op, "PUT", { atmId: A, date: D, cashCount: 99 })).status === 400);
  step("Admin correction on locked EOD needs a reason", (await call("/api/ops/eod/" + eodRow._id + "/admin-correct", admin, "PATCH", { dispenseApna: 29000 })).status === 400);
  step("Admin corrects locked EOD with reason", (await call("/api/ops/eod/" + eodRow._id + "/admin-correct", admin, "PATCH", { reason: "UAT Apna figure late", dispenseApna: 29500 })).status === 200);

  // 7
  scenario(7, "Ticket → Sales Officer visit → close; no Engineer app");
  const tk = await call("/api/complaints", fran, "POST", { atmId: A, problemType: "Dispenser", subject: "UAT cash not dispensing " + stamp });
  const tid = tk.data.id;
  step("franchisee raises ticket with docket", tk.status === 200 && /^DKT-/.test(tk.data.docketNumber || ""));
  step("desk assigns", (await call("/api/complaints/" + tid, admin, "PATCH", { action: "assign", ownerName: "UAT Desk" })).status === 200);
  step("non-field user cannot be dispatched", (await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: meA.id, scheduledAt: D + "T10:00" })).status === 400);
  const v = await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: soId, scheduledAt: D + "T10:00" });
  step("Sales Officer visit scheduled", v.status === 200);
  step("Sales Officer checks in with GPS", (await call("/api/visits/" + v.data.id, so, "PATCH", { action: "checkIn", lat: "22.7", lng: "75.8" })).status === 200);
  step("visit photo uploaded", (await call("/api/documents", so, "POST", { parentType: "visit", parentId: v.data.id, type: "Visit photo", fileName: "v.jpg", data: b64("v"), lat: "22.7", lng: "75.8" })).status === 200);
  await call("/api/visits/" + v.data.id, so, "PATCH", { action: "checkOut", lat: "22.7", lng: "75.8", atmConfirmed: true, atmIdSeen: A, findings: "UAT belt replaced, test ok" });
  step("visit submitted as Resolved", (await call("/api/visits/" + v.data.id, so, "PATCH", { action: "submit", outcome: "Resolved" })).status === 200);
  step("franchisee closes with remarks", (await call("/api/complaints/" + tid, fran, "PATCH", { action: "status", status: "Closed", closureRemarks: "UAT working now" })).status === 200);
  const closed = (await call("/api/complaints/" + tid, admin)).data.complaint;
  step("ticket Closed with visit resolution in history", closed.status === "Closed" && /belt replaced/.test(closed.resolution || ""));
  const engineerRoutes = await Promise.all(["/api/engineer", "/api/engineers", "/api/engineer/jobs"].map((p) => call(p, admin)));
  step("no Engineer app endpoints", engineerRoutes.every((r) => r.status === 404));

  // 8
  scenario(8, "Task assign + overdue");
  const opId = (await call("/api/users", admin)).data.users.find((u) => u.login === opLogin)._id;
  const task = await call("/api/tasks", admin, "POST", { title: "UAT follow up " + stamp, assigneeId: soId, managerId: opId, priority: "Critical", atmId: A, dueAt: new Date(Date.now() + 1500).toISOString() });
  step("task created and assigned", task.status === 200 && /^TSK-/.test(task.data.taskNo || ""));
  step("assignee notified", (await call("/api/notices", so)).data.rows.some((n) => n.kind === "assignment" && n.title.includes(task.data.taskNo)));
  step("assignee accepts", (await call("/api/tasks/" + task.data.id, so, "PATCH", { action: "status", to: "Accepted" })).status === 200);
  const oldCrit = (await call("/api/tasks/meta", admin)).data.settings.escalateAfterHours.Critical;
  await call("/api/tasks/settings", admin, "PATCH", { escalateAfterHours: { Critical: 0 } });
  await new Promise((r) => setTimeout(r, 2000));
  await call("/api/system/sweep", admin, "POST", {});
  await call("/api/tasks/settings", admin, "PATCH", { escalateAfterHours: { Critical: oldCrit } });
  const late = (await call("/api/tasks/" + task.data.id, admin)).data.task;
  step("past due shows Overdue and escalates to manager", late.displayStatus === "Overdue" && late.escalationLevel >= 1, JSON.stringify({ s: late.displayStatus, l: late.escalationLevel }));
  step("overdue view lists it", (await call("/api/tasks?view=overdue", admin)).data.rows.some((x) => x._id === task.data.id));
  step("manager got escalation notice", (await call("/api/notices", op)).data.rows.some((n) => n.kind === "escalation"));

  // 9
  scenario(9, "Dexter-3 report export scoped to company");
  const rep = (tok, kind, q) => call("/api/reports/view/" + kind + "?month=" + month + "&atmId=" + A + (q || ""), tok);
  const d3 = await rep(admin, "dlr3", "&csv=1");
  step("Admin exports DLR 3 CSV with the ATM", d3.status === 200 && d3.data.csv.includes(A));
  step("franchisee views own ATM on screen", JSON.stringify((await rep(fran, "dlr3")).data.rows || []).includes(A));
  step("franchisee without Export cannot download the CSV", (await rep(fran, "dlr3", "&csv=1")).status === 403);
  step("sibling franchise view has none of it", !JSON.stringify((await rep(sib, "dlr3")).data.rows || []).includes(A));
  step("company B export has none of it", !((await rep(adminB, "dlr3", "&csv=1")).data.csv || "").includes(A));
  step("export audited", (await call("/api/audit?event=ReportExported&pageSize=20", admin)).data.events.some((e) => new Date(e.at) >= started));

  // 10
  scenario(10, "Mail compose + tracker row on ticket");
  const mailbox = (await call("/api/mail/meta", admin)).data.mailbox;
  if (!mailbox || !mailbox.address) await call("/api/mail/mailbox", admin, "POST", { address: "desk@demo.local" });
  const mt = await call("/api/complaints", fran, "POST", { atmId: A, problemType: "Display", subject: "UAT screen blank " + stamp });
  const rnd = (await call("/api/mail/render", admin, "POST", { templateKey: "ack", complaintId: mt.data.id })).data;
  step("template fills docket and ATM", (rnd.subject || "").includes(mt.data.docketNumber) && (rnd.body || "").includes(A));
  const sent = await call("/api/mail", admin, "POST", { complaintId: mt.data.id, templateKey: "ack", to: "fr@demo.local", subject: rnd.subject, body: rnd.body });
  step("mail sent on the ticket", sent.status === 200 && sent.data.status === "Sent");
  step("ticket history records it", (await call("/api/complaints/" + mt.data.id, admin)).data.complaint.history.some((h) => h.action === "Mail sent"));
  step("franchisee sees the thread", (await call("/api/mail?complaintId=" + mt.data.id, fran)).data.rows.length === 1);
  const row = await call("/api/mail/tracker/penalty", admin, "POST", { atmId: A, days: 2, penalty: "1000", month });
  step("tracker row saved for the ticket's ATM", row.status === 200);
  step("tracker row listed", (await call("/api/mail/tracker/penalty?month=" + month, admin)).data.rows.some((r) => r.atmId === A));

  // 11
  scenario(11, "Audit export shows the tester's edits");
  const aexp = await call("/api/audit/export?login=" + encodeURIComponent(opLogin), admin);
  const lines = (aexp.data.csv || "").split("\n");
  step("export downloads", aexp.status === 200 && lines[0].includes("at_ist,event"));
  step("tester's login is in the export", lines.some((l) => l.includes("LoginSuccess") && l.includes(opLogin)));
  step("tester's EOD edits are in the export", ["EODSaved", "EODSubmitted"].every((e) => lines.some((l) => l.includes("," + e + ",") && l.includes(A))));
  step("rows carry IP", lines.slice(1).filter(Boolean).every((l) => l.split(",")[6] !== ""));
  step("Admin correction on the tester's EOD is exported", (await call("/api/audit/export?event=EODAdminCorrected", admin)).data.csv.includes("UAT Apna figure late"));

  // 12
  scenario(12, "No Lead, no R&M screens");
  const probes = await Promise.all(["/api/leads", "/api/lead", "/api/rm", "/api/r-and-m", "/api/repairs"].map((p) => call(p, admin)));
  step("no Lead or R&M API", probes.every((r) => r.status === 404));
  step("task source Lead refused", (await call("/api/tasks", admin, "POST", { title: "x", source: "Lead", dueAt: new Date(Date.now() + 86400000).toISOString() })).status === 400);
  step("no Lead dashboard", (await call("/api/dashboard/leads", admin)).status === 404);
  const src = fs.readdirSync(FRONTEND).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => fs.readFileSync(path.join(FRONTEND, f), "utf8")).join("\n");
  step("no Lead / R&M / Engineer screen in the web app", !/\bLeads?\b|R&M|Repair and Maintenance|Engineer/.test(src));

  // 13
  scenario(13, "Security settings and outside services (off by default)");
  const rc = await call("/api/auth/recovery-codes", op, "POST", {});
  step("user issues recovery codes", rc.status === 200 && (rc.data.codes || []).length === 8);
  const t13 = await call("/api/auth/login", null, "POST", { login: opLogin, password: "UatOp@12345" });
  const viaCode = await call("/api/auth/mfa", null, "POST", { ticket: t13.data.ticket, recoveryCode: (rc.data.codes || [])[0] });
  step("recovery code signs in once", viaCode.status === 200 && !!viaCode.data.token);
  const t13b = await call("/api/auth/login", null, "POST", { login: opLogin, password: "UatOp@12345" });
  step("the same recovery code is refused the second time", (await call("/api/auth/mfa", null, "POST", { ticket: t13b.data.ticket, recoveryCode: (rc.data.codes || [])[0] })).status === 401);
  step("record level set to own records", (await call("/api/users/" + opId, admin, "PATCH", { recordScope: "own" })).status === 200);
  step("own-records user does not see others' applications", !(await call("/api/applications", op)).data.applications.some((x) => x._id === appId));
  await call("/api/users/" + opId, admin, "PATCH", { recordScope: "all" });
  const cards = (await call("/api/adapters", admin)).data.adapters || [];
  step("Admin sees a status card per outside service, all off", cards.length >= 8 && cards.filter((a) => a.key !== "ppt").every((a) => !a.on));
  step("test button says not configured while off", /^not configured/.test((await call("/api/adapters/mail/test", admin, "POST", { to: "x@demo.local" })).data.message || ""));
  const deck = await call("/api/site-projects/" + pid + "/pptx", admin, "POST", {});
  step("project photo PPT downloads", deck.status === 200 && Buffer.from(deck.data.data || "", "base64").slice(0, 2).toString() === "PK");
  step("adapter test audited", (await call("/api/audit?event=AdapterTested&pageSize=5", admin)).data.events.some((e) => new Date(e.at) >= started));

  // report
  const total = scenarios.reduce((n, s) => n + s.steps.length, 0);
  const failed = scenarios.reduce((n, s) => n + s.steps.filter((x) => !x.ok).length, 0);
  const at = new Date(Date.now() + 330 * 60000).toISOString().replace("T", " ").slice(0, 16);
  const md = [
    "# UAT run — LLD 08 §8 checklist",
    "",
    "Run: " + at + " IST against " + B + ". Command: `npm run uat` (needs the API running and `npm run seed` done once).",
    "Every run makes its own ATM (`" + A + "`), users and tickets, so it can be repeated.",
    "",
    "Result: **" + (total - failed) + " / " + total + " steps passed** across " + scenarios.length + " scenarios.",
    "",
    "| # | Scenario | Result |",
    "| --- | --- | --- |",
    ...scenarios.map((s) => {
      const bad = s.steps.filter((x) => !x.ok).length;
      return "| " + s.no + " | " + s.title + " | " + (bad ? bad + " failed of " + s.steps.length : "Pass (" + s.steps.length + " steps)") + " |";
    }),
    "",
    ...scenarios.flatMap((s) => ["## " + s.no + ". " + s.title, "", ...s.steps.map((x) => "- " + (x.ok ? "Pass" : "**Fail**") + " — " + x.name + (x.detail ? " (`" + x.detail.slice(0, 200) + "`)" : "")), ""]),
    "## Sign-off",
    "",
    "UAT sign-off or production use of a module is acceptance of that module (quotation rule).",
    "",
    "| Module | Client tester | Date | Signed |",
    "| --- | --- | --- | --- |",
    "| Onboarding (application, KYC, LOI, agreement, ATM Master) | | | |",
    "| Projects to Cash Live | | | |",
    "| Daily operations and reports | | | |",
    "| Complaints, visits, inspections | | | |",
    "| Tasks and notices | | | |",
    "| Mail and trackers | | | |",
    "| Audit, sessions, mobile web | | | |",
    "| Security settings and outside-service adapters | | | |",
    "",
  ].join("\n");
  fs.writeFileSync(REPORT, md);
  console.log((failed ? failed + " failed" : "all passed") + " — " + (total - failed) + "/" + total + " — report " + REPORT);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
