require("../src/config/env");
const B = process.env.API_URL || "http://127.0.0.1:4000";

async function call(path, token, method = "GET", body) {
  const r = await fetch(B + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function login(l, p) {
  const a = await call("/api/auth/login", null, "POST", { login: l, password: p });
  if (!a.data.ticket) throw new Error("login failed " + l + " " + JSON.stringify(a.data));
  const m = await call("/api/auth/mfa", null, "POST", { ticket: a.data.ticket, otp: a.data.otpDemo });
  return m.data.token;
}

async function sweep(token) {
  for (let i = 0; i < 30; i++) {
    const r = await call("/api/system/sweep", token, "POST", {});
    if (r.status !== 409) return r;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error("sweep stayed busy for 30 seconds");
}

let failed = 0;
function check(name, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + name);
}

const b64 = (s) => Buffer.from(s).toString("base64");

async function findUser(token, loginId) {
  const u = (await call("/api/users", token)).data.users.find((x) => x.login === loginId);
  return u ? u._id : "000000000000000000000000";
}

(async () => {
  const stamp = Date.now();
  check("unauthenticated blocked", (await call("/api/applications", null)).status === 401);
  const admin = await login("admin@demo.local", "Admin@123");
  const fran = await login("franchisee@demo.local", "Fran@123");
  const sm = await login("supermaster@demo.local", "Super@123");
  const adminB = await login("admin-b@demo.local", "AdminB@123");

  const forgot = await call("/api/auth/forgot", null, "POST", { login: "admin@demo.local" });
  const bypass = await call("/api/auth/mfa", null, "POST", { ticket: forgot.data.ticket, otp: forgot.data.otpDemo });
  check("password-reset code cannot be used to log in", bypass.status === 401 && !bypass.data.token);

  const esc = await call("/api/users", admin, "POST", { login: "esc" + stamp + "@x", password: "a", name: "esc", hierarchy: "DexterIndiaCompanyTeam" });
  check("company Admin cannot create a Dexter India user", esc.status === 403);
  const noNode = await call("/api/users", admin, "POST", { login: "nonode" + stamp + "@x", password: "a", name: "n", hierarchy: "Franchise" });
  check("franchise user needs franchise node", noNode.status === 400);

  const frs = (await call("/api/franchises", admin)).data.franchises;
  const otherNode = await call("/api/franchises", admin, "POST", { name: "Smoke Other " + stamp, layer: "Franchise" });

  const fa = await call("/api/applications", fran, "POST", { siteLocationName: "Fran Site " + stamp, city: "Indore", siteNumber: "HACK" });
  const aa = await call("/api/applications", admin, "POST", { siteLocationName: "Admin Site " + stamp, city: "Bhopal", franchiseId: otherNode.data.id });
  const planted = await call("/api/applications", fran, "POST", { siteLocationName: "Planted " + stamp, franchiseId: otherNode.data.id });
  const all = (await call("/api/applications", admin)).data.applications;
  const fRow = all.find((x) => x._id === fa.data.id);
  const pRow = all.find((x) => x._id === planted.data.id);
  check("franchisee cannot set office site number", fRow && !fRow.siteNumber);
  check("franchisee cannot file under another franchise", pRow && String(pRow.franchiseId) !== otherNode.data.id);

  const bList = (await call("/api/applications", adminB)).data.applications;
  check("company B cannot see company A applications", !bList.some((x) => x._id === fa.data.id || x._id === aa.data.id));
  check("company B cannot edit company A application", (await call("/api/applications/" + fa.data.id, adminB, "PATCH", { city: "X" })).status === 403);
  check("franchisee cannot edit another franchise's application", (await call("/api/applications/" + aa.data.id, fran, "PATCH", { city: "X" })).status === 403);
  check("super master cannot edit outside subtree", (await call("/api/applications/" + aa.data.id, sm, "PATCH", { city: "X" })).status === 403);
  check("super master sees subtree application", (await call("/api/applications", sm)).data.applications.some((x) => x._id === fa.data.id));
  check("super master cannot open 360 outside subtree", (await call("/api/franchise-360/" + otherNode.data.id, sm)).status === 403);

  check("unsubmitted application cannot be approved", (await call("/api/applications/" + aa.data.id, admin, "PATCH", { approve: true })).status === 400);
  await call("/api/applications/" + aa.data.id, admin, "PATCH", { submit: true });
  check("submitted application can be approved", (await call("/api/applications/" + aa.data.id, admin, "PATCH", { approve: true })).status === 200);

  const d1 = await call("/api/documents", fran, "POST", { parentId: fa.data.id, type: "PAN", fileName: "pan.txt", mime: "text/plain", data: b64("pan") });
  const d2 = await call("/api/documents", fran, "POST", { parentId: fa.data.id, type: "PAN", fileName: "pan2.txt", mime: "text/plain", data: b64("pan2") });
  check("KYC versioning", d1.data.version === 1 && d2.data.version === 2);
  check("franchisee cannot upload on another application", (await call("/api/documents", fran, "POST", { parentId: aa.data.id, type: "PAN", fileName: "x", data: b64("x") })).status === 403);
  const adminDoc = await call("/api/documents", admin, "POST", { parentId: aa.data.id, type: "PAN", fileName: "a.txt", data: b64("a") });
  check("franchisee cannot download another application's KYC", (await call("/api/documents/" + adminDoc.data.id + "/file", fran)).status === 404);
  check("franchisee can download own KYC", (await call("/api/documents/" + d2.data.id + "/file", fran)).status === 200);
  check("admin verifies KYC", (await call("/api/documents/" + d2.data.id + "/verify", admin, "PATCH", { approve: true })).status === 200);

  check("franchisee cannot set Link Shared on application", (await call("/api/applications/" + fa.data.id, fran, "PATCH", { agreementStatus: "Link Shared" })).status === 403);
  const otherAgr = await call("/api/agreements", admin, "POST", { applicationId: aa.data.id, franchiseId: otherNode.data.id });
  check("franchisee cannot touch another franchise's agreement", (await call("/api/agreements/" + otherAgr.data.id, fran, "PATCH", { status: "Uploaded" })).status === 403);
  const ownAgr = await call("/api/agreements", fran, "POST", { applicationId: fa.data.id, status: "Approved" });
  const ownAgrRow = (await call("/api/agreements", admin)).data.agreements.find((x) => x._id === ownAgr.data.id);
  check("agreement cannot be created pre-approved", ownAgrRow && ownAgrRow.status === "Pending");
  check("franchisee cannot approve own agreement", (await call("/api/agreements/" + ownAgr.data.id, fran, "PATCH", { status: "Approved" })).status === 403);
  check("franchisee cannot mark Uploaded without a file", (await call("/api/agreements/" + ownAgr.data.id, fran, "PATCH", { status: "Uploaded" })).status === 400);
  await call("/api/documents", fran, "POST", { parentType: "agreement", parentId: ownAgr.data.id, type: "Signed agreement", fileName: "agr.pdf", data: b64("agr") });
  check("franchisee can mark own agreement Uploaded", (await call("/api/agreements/" + ownAgr.data.id, fran, "PATCH", { status: "Uploaded" })).status === 200 || (await call("/api/agreements", admin)).data.agreements.find((x) => x._id === ownAgr.data.id).status === "Uploaded");
  check("admin sets agreement Link Shared", (await call("/api/agreements/" + ownAgr.data.id, admin, "PATCH", { status: "Link Shared" })).status === 200);
  const ownLoi = await call("/api/lois", fran, "POST", { loiCode: "SMOKE-" + stamp, applicationId: fa.data.id });
  check("franchisee cannot approve LOI", (await call("/api/lois/" + ownLoi.data.id, fran, "PATCH", { status: "Approved" })).status === 403);
  check("admin approves LOI", (await call("/api/lois/" + ownLoi.data.id, admin, "PATCH", { approve: true })).status === 200);

  check("admin adds agreement column", (await call("/api/register-columns", admin, "POST", { register: "agreement", name: "Courier AWB " + stamp, type: "text" })).status === 200);
  check("franchisee cannot add column", (await call("/api/register-columns", fran, "POST", { register: "agreement", name: "x" })).status === 403);

  check("ATM requires serial + machine type", (await call("/api/atms", admin, "POST", { atmId: "SMOKE-" + stamp })).status === 400);
  check("ATM create with serial + machine type", (await call("/api/atms", admin, "POST", { atmId: "SMOKE-" + stamp, atmSerialNumber: "SN1", machineTypeModel: "NCR 6622" })).status === 200);
  check("franchisee cannot create ATM", (await call("/api/atms", fran, "POST", { atmId: "F1", atmSerialNumber: "S", machineTypeModel: "M" })).status === 403);

  const t1 = await call("/api/auth/login", null, "POST", { login: "admin@demo.local", password: "Admin@123" });
  for (let i = 0; i < 5; i++) await call("/api/auth/mfa", null, "POST", { ticket: t1.data.ticket, otp: "000000" });
  const late = await call("/api/auth/mfa", null, "POST", { ticket: t1.data.ticket, otp: t1.data.otpDemo });
  check("MFA ticket dies after 5 wrong codes", late.status === 401);

  check("Admin cannot grant Dexter India layer by edit", (await call("/api/users/" + (await findUser(admin, "franchisee@demo.local")), admin, "PATCH", { hierarchy: "DexterIndiaCompanyTeam" })).status === 403);
  check("Admin cannot grant companies", (await call("/api/users/" + (await findUser(admin, "franchisee@demo.local")), admin, "PATCH", { grantedCompanyIds: [] })).status === 403);
  const dLogin = "director" + stamp + "@x";
  const dex0 = await login("dexter@demo.local", "Dexter@123");
  check("company Admin cannot create a Director (above them)", (await call("/api/users", admin, "POST", { login: "d2" + stamp + "@x", password: "Dir@1234", name: "D2", hierarchy: "Director" })).status === 403);
  check("weak password refused", (await call("/api/users", admin, "POST", { login: "weak" + stamp + "@x", password: "abc", name: "W", hierarchy: "SubAdmin" })).status === 400);
  const dUser = await call("/api/users", dex0, "POST", { login: dLogin, password: "Dir@1234", name: "Director " + stamp, hierarchy: "Director" });
  await call("/api/users/" + dUser.data.id + "/activate", dex0, "PATCH");
  const director = await login(dLogin, "Dir@1234");
  check("Director can approve a submitted application", await (async () => {
    const x = await call("/api/applications", admin, "POST", { siteLocationName: "Dir " + stamp });
    await call("/api/applications/" + x.data.id, admin, "PATCH", { submit: true });
    return (await call("/api/applications/" + x.data.id, director, "PATCH", { approve: true })).status === 200;
  })());
  check("Admin cannot edit a Director", (await call("/api/users/" + dUser.data.id, admin, "PATCH", { functionalRole: "Verifier" })).status === 403);
  check("Dexter India can change role / scope", (await call("/api/users/" + dUser.data.id, dex0, "PATCH", { functionalRole: "Verifier", actions: ["View", "Approve"] })).status === 200);
  check("Dexter India can deactivate user", (await call("/api/users/" + dUser.data.id, dex0, "PATCH", { active: false })).status === 200);
  check("deactivated user session ends", (await call("/api/applications", director)).status === 401);
  check("deactivated user cannot log in", (await call("/api/auth/login", null, "POST", { login: dLogin, password: "Dir@1234" })).status === 401);

  const dexter = await login("dexter@demo.local", "Dexter@123");
  check("Dexter India team creates a company", (await call("/api/companies", dexter, "POST", { name: "Smoke Co " + stamp, code: "SM" + stamp })).status === 200);
  check("Admin cannot create a company", (await call("/api/companies", admin, "POST", { name: "x", code: "X" + stamp })).status === 403);

  const sb = await call("/api/applications", fran, "POST", { siteLocationName: "SendBack " + stamp });
  await call("/api/applications/" + sb.data.id, fran, "PATCH", { submit: true });
  check("franchisee cannot edit after submit", (await call("/api/applications/" + sb.data.id, fran, "PATCH", { city: "Y" })).status === 403);
  check("verifier sends back for resubmission", (await call("/api/applications/" + sb.data.id, admin, "PATCH", { sendBack: true, reason: "fix PIN" })).status === 200);
  check("franchisee edits a Resubmission row", (await call("/api/applications/" + sb.data.id, fran, "PATCH", { pin: "452001" })).status === 200);
  check("franchisee resubmits", (await call("/api/applications/" + sb.data.id, fran, "PATCH", { submit: true })).status === 200);
  const draftEdit = await call("/api/applications", fran, "POST", { siteLocationName: "Draft " + stamp });
  await call("/api/applications/" + draftEdit.data.id, fran, "PATCH", { siteNumber: "HACK2", city: "Pune" });
  const draftRow = (await call("/api/applications", admin)).data.applications.find((x) => x._id === draftEdit.data.id);
  check("franchisee edits own draft but not site number", draftRow && draftRow.city === "Pune" && !draftRow.siteNumber);

  const upAgr = await call("/api/agreements", fran, "POST", { applicationId: fa.data.id });
  await call("/api/documents", fran, "POST", { parentType: "agreement", parentId: upAgr.data.id, type: "Agreement", fileName: "agr.pdf", data: b64("pdf") });
  const upRow = (await call("/api/agreements", admin)).data.agreements.find((x) => x._id === upAgr.data.id);
  check("agreement file upload sets Uploaded", upRow && upRow.status === "Uploaded");
  check("franchisee cannot upload on another franchise's agreement", (await call("/api/documents", fran, "POST", { parentType: "agreement", parentId: otherAgr.data.id, type: "Agreement", fileName: "x", data: b64("x") })).status === 403);
  check("franchisee cannot set agreement extra column", (await call("/api/agreements/" + upAgr.data.id, fran, "PATCH", { extra: { x: "1" } })).status === 403);

  const atmList = (await call("/api/atms", admin)).data.atms;
  const smokeAtm = atmList.find((a) => a.atmId === "SMOKE-" + stamp);
  check("admin edits ATM", (await call("/api/atms/" + smokeAtm._id, admin, "PATCH", { city: "Pune", machineTypeModel: "Hyosung" })).status === 200);
  check("ATM edit cannot blank serial", (await call("/api/atms/" + smokeAtm._id, admin, "PATCH", { atmSerialNumber: "" })).status === 400);
  check("franchisee cannot edit ATM", (await call("/api/atms/" + smokeAtm._id, fran, "PATCH", { city: "X" })).status === 403);

  const rem = await call("/api/reminders", fran);
  check("affidavit reminders list", rem.status === 200 && Array.isArray(rem.data.affidavitPending));

  // Phase 2 slice 1: project board
  const pApp = await call("/api/applications", fran, "POST", { siteLocationName: "Project Site " + stamp, city: "Indore", model: "Sapphire" });
  check("project cannot start from unapproved site", (await call("/api/site-projects", admin, "POST", { applicationId: pApp.data.id })).status === 400);
  await call("/api/applications/" + pApp.data.id, fran, "PATCH", { submit: true });
  await call("/api/applications/" + pApp.data.id, admin, "PATCH", { approve: true });
  check("franchisee cannot create project", (await call("/api/site-projects", fran, "POST", { applicationId: pApp.data.id })).status === 403);
  const proj = await call("/api/site-projects", admin, "POST", { applicationId: pApp.data.id });
  check("project created from approved site", proj.status === 200);
  check("one project per site", (await call("/api/site-projects", admin, "POST", { applicationId: pApp.data.id })).status === 409);
  const pid = proj.data.id;
  check("franchisee sees own project", (await call("/api/site-projects", fran)).data.projects.some((x) => x._id === pid));
  check("super master sees subtree project", (await call("/api/site-projects/" + pid, sm)).status === 200);
  check("company B cannot open project", (await call("/api/site-projects/" + pid, adminB)).status === 404);
  check("stage 2 locked until stage 1 approved", (await call("/api/site-projects/" + pid + "/stages/1", admin, "PATCH", { status: "In Progress" })).status === 400);
  check("franchisee cannot approve a stage", (await call("/api/site-projects/" + pid + "/stages/0/approve", fran, "POST", {})).status === 403);
  check("approve Project Assigned", (await call("/api/site-projects/" + pid + "/stages/0/approve", admin, "POST", {})).status === 200);
  check("franchisee cannot edit stage", (await call("/api/site-projects/" + pid + "/stages/1", fran, "PATCH", { status: "In Progress" })).status === 403);
  check("TIS cannot be approved without evidence", (await call("/api/site-projects/" + pid + "/stages/1/approve", admin, "POST", {})).status === 400);
  const evUp = await call("/api/documents", fran, "POST", { parentType: "project", parentId: pid, type: "Stage: TIS", fileName: "tis.jpg", data: b64("img"), lat: "22.7", lng: "75.8", capturedAt: new Date().toISOString() });
  check("franchisee uploads stage evidence with GPS", evUp.status === 200);
  check("franchisee cannot upload evidence on another company project", (await call("/api/documents", adminB, "POST", { parentType: "project", parentId: pid, type: "Stage: TIS", fileName: "x", data: b64("x") })).status === 404);
  check("approve TIS after evidence", (await call("/api/site-projects/" + pid + "/stages/1/approve", admin, "POST", {})).status === 200);

  const meta = (await call("/api/site-projects/meta", admin)).data;
  for (let i = 2; i <= 8; i++) {
    await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: " + meta.stages[i], fileName: "e.jpg", data: b64("e") });
    await call("/api/site-projects/" + pid + "/stages/" + i + "/approve", admin, "POST", {});
  }
  await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: Tech Live", fileName: "e.jpg", data: b64("e") });
  check("Tech Live needs a date", (await call("/api/site-projects/" + pid + "/stages/9/approve", admin, "POST", {})).status === 400);
  check("Tech Live approved with date", (await call("/api/site-projects/" + pid + "/stages/9/approve", admin, "POST", { date: "2026-09-25" })).status === 200);
  await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: Cash Live", fileName: "e.jpg", data: b64("e") });
  check("Cash Live needs linked ATM", (await call("/api/site-projects/" + pid + "/stages/10/approve", admin, "POST", { date: "2026-09-28" })).status === 400);
  check("unknown ATM cannot be linked", (await call("/api/site-projects/" + pid, admin, "PATCH", { atmId: "NOPE-" + stamp })).status === 400);
  await call("/api/site-projects/" + pid, admin, "PATCH", { atmId: "SMOKE-" + stamp });
  check("Cash Live approved", (await call("/api/site-projects/" + pid + "/stages/10/approve", admin, "POST", { date: "2026-09-28" })).status === 200);
  const liveAtm = (await call("/api/atms", admin)).data.atms.find((a) => a.atmId === "SMOKE-" + stamp);
  check("Cash Live date written to ATM Master", liveAtm && !!liveAtm.cashLiveDate);
  check("approve Project Completed", (await call("/api/site-projects/" + pid + "/stages/11/approve", admin, "POST", {})).status === 200);
  const done = (await call("/api/site-projects/" + pid, admin)).data.project;
  check("project shows Completed at 100%", done.view === "Completed" && done.progress === 100);
  const auditEv = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check("audit has ProjectCreated, EvidenceUploaded, TechLiveSet, CashLiveSet", ["ProjectCreated", "EvidenceUploaded", "TechLiveSet", "CashLiveSet"].every((x) => auditEv.includes(x)));

  check("approved site with a project cannot be rejected", (await call("/api/applications/" + pApp.data.id, admin, "PATCH", { reject: true })).status === 400);
  check("Cash Live project cannot unlink its ATM", (await call("/api/site-projects/" + pid, admin, "PATCH", { atmId: "" })).status === 400);
  check("Admin moves Cash Live date; ATM Master follows", await (async () => {
    const r = await call("/api/site-projects/" + pid + "/stages/10", admin, "PATCH", { date: "2026-09-27" });
    const a = (await call("/api/atms", admin)).data.atms.find((x) => x.atmId === "SMOKE-" + stamp);
    const back = await call("/api/site-projects/" + pid + "/stages/10", admin, "PATCH", { date: "2026-09-28" });
    return r.status === 200 && a && String(a.cashLiveDate).startsWith("2026-09-27") && back.status === 200;
  })());

  const proj2 = await call("/api/site-projects", admin, "POST", { applicationId: aa.data.id });
  check("hold needs a reason", (await call("/api/site-projects/" + proj2.data.id, admin, "PATCH", { held: true })).status === 400);
  check("ATM already linked elsewhere cannot be linked again", (await call("/api/site-projects/" + proj2.data.id, admin, "PATCH", { atmId: "SMOKE-" + stamp })).status >= 400);
  check("hold a project", (await call("/api/site-projects/" + proj2.data.id, admin, "PATCH", { held: true, heldReason: "landlord dispute" })).status === 200);
  check("held project blocks stage work", (await call("/api/site-projects/" + proj2.data.id + "/stages/0/approve", admin, "POST", {})).status === 400);
  check("held project listed under Held", (await call("/api/site-projects?view=Held", admin)).data.projects.some((x) => x._id === proj2.data.id));
  check("resume a project", (await call("/api/site-projects/" + proj2.data.id, admin, "PATCH", { held: false })).status === 200);
  check("franchisee cannot see another franchise's project", (await call("/api/site-projects/" + proj2.data.id, fran)).status === 403);

  // Phase 2 slice 2: daily operations (ATM went Cash Live on 2026-09-28 above)
  const A = "SMOKE-" + stamp;
  const txn = (tok, date, extra) => call("/api/ops/txn", tok, "PUT", { atmId: A, date, cashCount: 0, cashAmount: 0, ...extra });
  check("TXN before Cash Live date rejected", (await txn(admin, "2026-09-27")).status === 400);
  check("TXN for unknown ATM rejected", (await call("/api/ops/txn", admin, "PUT", { atmId: "NOPE", date: "2026-09-28" })).status === 400);
  check("company B cannot write TXN for company A ATM", (await txn(adminB, "2026-09-28")).status === 400);
  check("franchisee cannot enter TXN", (await txn(fran, "2026-09-28")).status === 403);
  check("TXN saved (zero day 1)", (await txn(admin, "2026-09-28")).status === 200);
  check("TXN saved (zero day 2)", (await txn(admin, "2026-09-29")).status === 200);
  const tm = (await call("/api/ops/txn?month=2026-09", admin)).data;
  const ts = tm.summary.find((s) => s.atmId === A);
  check("zero TXN and consecutive zero flagged", ts && ts.zeroDays >= 2 && ts.consecutiveZero >= 2 && tm.rows.some((r) => r.atmId === A && r.zeroTxn));
  check("franchisee sees own ATM TXN", (await call("/api/ops/txn?month=2026-09", fran)).data.rows.some((r) => r.atmId === A));
  check("company B sees no company A TXN", !(await call("/api/ops/txn?month=2026-09", adminB)).data.rows.some((r) => r.atmId === A));

  const badCbr = await call("/api/ops/cbr1", admin, "PUT", { atmId: A, date: "2026-09-28", denos: { 100: { openingNotes: 200, openingAmount: 30000 } } });
  check("CBR 1 rejects notes × deno ≠ amount", badCbr.status === 400);
  await call("/api/ops/cbr1", admin, "PUT", {
    atmId: A,
    date: "2026-09-28",
    cra: "CRA-1",
    denos: { 100: { openingNotes: 200, dispensedNotes: 300, overageNotes: 100 }, 200: { openingNotes: 500, shortageNotes: 500 }, 500: { openingNotes: 1000, shortageNotes: 1000 } },
  });
  const c1 = (await call("/api/ops/cbr1?date=2026-09-28", admin)).data.rows.find((r) => r.atmId === A);
  check("CBR 1 totals match Dexter-3 sample (opening 620000, shortage 600000)", c1 && c1.totals.opening === 620000 && c1.totals.shortage === 600000 && c1.totals.dispensed === 30000);
  check("CBR 2 saved", (await call("/api/ops/cbr2", admin, "PUT", { atmId: A, date: "2026-09-28", mfName: "FR", opening: 100000, dispense: 30000, closing: 70000 })).status === 200);

  await call("/api/ops/funding", admin, "PUT", { type: "WLA", atmId: A, date: "2026-09-28", openingWla: 50000, fundHpy: 100000, withdrawal: 150000, loadingCbr: 150000 });
  await call("/api/ops/funding", admin, "PUT", { type: "Axis", atmId: A, date: "2026-09-28", lastDayDispenseApna: 300100, axisLot1: 473100, axisLot2: 0, loadingCbr: 400000 });
  const fundAdmin = (await call("/api/ops/funding?date=2026-09-28", admin)).data.rows.filter((r) => r.atmId === A);
  const wla = fundAdmin.find((r) => r.type === "WLA");
  const axis = fundAdmin.find((r) => r.type === "Axis");
  check("WLA closing = opening + HPY − withdrawal", wla && wla.closingWla === 0 && wla.calcMismatch === false);
  check("Axis loading difference flagged for Admin", axis && axis.loadingDiff === -73100 && axis.calcMismatch === true);
  const fundFran = (await call("/api/ops/funding?date=2026-09-28", fran)).data.rows.filter((r) => r.atmId === A);
  check("wrong-calculation flag hidden from non-Admin", fundFran.length === 2 && fundFran.every((r) => r.calcMismatch === undefined));
  check("franchisee cannot correct funding", (await call("/api/ops/funding/" + axis._id + "/correct", fran, "PATCH", { reason: "x" })).status === 403);
  check("Admin corrects funding with reason", (await call("/api/ops/funding/" + axis._id + "/correct", admin, "PATCH", { reason: "CBR loading keyed short", loadingCbr: 473100 })).status === 200);
  const axisFixed = (await call("/api/ops/funding?date=2026-09-28", admin)).data.rows.find((r) => r.atmId === A && r.type === "Axis");
  check("Admin correction recalculates and clears flag", axisFixed && axisFixed.loadingDiff === 0 && axisFixed.calcMismatch === false && axisFixed.adminCorrected);

  const saLogin = "subadmin" + stamp + "@x";
  const sa = await call("/api/users", admin, "POST", { login: saLogin, password: "Sub@1234", name: "Sub " + stamp, hierarchy: "SubAdmin" });
  await call("/api/users/" + sa.data.id + "/activate", admin, "PATCH");
  const sub = await login(saLogin, "Sub@1234");
  const eodBody = { atmId: A, date: "2026-09-28", opening: 100000, dispenseMachine: 30000, dispenseApna: 29000, physicalNotes: { 500: 140 }, loadingNotes: { 500: 200 } };
  const e1 = await call("/api/ops/eod", sub, "PUT", eodBody);
  check("EOD calculates overage/shortage/closing", e1.status === 200 && e1.data.overage === 0 && e1.data.shortage === 0 && e1.data.closing === 170000 && e1.data.dispenseFlag === true);
  const eodRow = (await call("/api/ops/eod?date=2026-09-28", admin)).data.rows.find((r) => r.atmId === A);
  check("EOD submitted", (await call("/api/ops/eod/" + eodRow._id + "/submit", sub, "POST", {})).status === 200);
  check("submitted EOD cannot be re-saved", (await call("/api/ops/eod", sub, "PUT", eodBody)).status === 403);
  check("franchisee cannot verify EOD", (await call("/api/ops/eod/" + eodRow._id + "/verify", fran, "POST", {})).status === 403);
  check("EOD verified and locked", (await call("/api/ops/eod/" + eodRow._id + "/verify", admin, "POST", {})).status === 200);
  check("locked day blocks non-Admin TXN edit", (await txn(sub, "2026-09-28", { cashCount: 5 })).status === 400);
  check("Sub Admin cannot Admin-correct EOD", (await call("/api/ops/eod/" + eodRow._id + "/admin-correct", sub, "PATCH", { reason: "x" })).status === 403);
  check("Admin corrects locked EOD with reason", (await call("/api/ops/eod/" + eodRow._id + "/admin-correct", admin, "PATCH", { reason: "Apna figure late", dispenseApna: 30000 })).status === 200);
  const e2 = await call("/api/ops/eod", sub, "PUT", { atmId: A, date: "2026-09-29", dispenseMachine: 0, dispenseApna: 0, physicalNotes: { 500: 340 } });
  check("next-day EOD opening = previous closing", e2.status === 200 && e2.data.opening === 170000);
  await call("/api/ops/eod/" + eodRow._id + "/admin-correct", admin, "PATCH", { reason: "recount", physicalNotes: { 500: 150 } });
  const day29 = (await call("/api/ops/eod?date=2026-09-29", admin)).data.rows.find((r) => r.atmId === A);
  check("correcting a day carries closing into next Draft opening", day29 && day29.opening === 175000 && day29.expected === 175000);
  await call("/api/ops/eod/" + day29._id + "/submit", sub, "POST", {});
  check("submitter cannot verify own EOD", (await call("/api/ops/eod/" + day29._id + "/verify", sub, "POST", {})).status === 403);
  check("return to Draft needs a reason", (await call("/api/ops/eod/" + day29._id + "/verify", admin, "POST", { returnToDraft: true })).status === 400);
  await call("/api/ops/eod/" + day29._id + "/verify", admin, "POST", {});
  await call("/api/ops/eod/" + eodRow._id + "/admin-correct", admin, "PATCH", { reason: "recount 2", physicalNotes: { 500: 160 } });
  const day29b = (await call("/api/ops/eod?date=2026-09-29", admin)).data.rows.find((r) => r.atmId === A);
  check("verified next day is flagged when previous closing changes", day29b && day29b.openingMismatch === true && day29b.opening === 175000);
  await call("/api/ops/eod/" + day29._id + "/admin-correct", admin, "PATCH", { reason: "take new opening", opening: 180000 });
  const day29c = (await call("/api/ops/eod?date=2026-09-29", admin)).data.rows.find((r) => r.atmId === A);
  check("Admin correcting the opening clears the flag", day29c && day29c.openingMismatch === false);

  const csv = [
    "atmId,date,cashCount,cashAmount,upiCount,upiAmount",
    A + ",2026-09-30,10,5000,2,400",
    "NOPE-ATM,2026-09-30,1,100,0,0",
    A + ",30.09.2026,abc,100,0,0",
    A + ",2026-09-27,1,100,0,0",
  ].join("\n");
  const imp = await call("/api/imports", admin, "POST", { template: "TXN-daily", fileName: "txn.csv", csv });
  check("TXN import accepts good rows, rejects bad", imp.status === 200 && imp.data.batch.accepted === 1 && imp.data.batch.rejected === 3);
  const errFile = await call("/api/imports/" + imp.data.batch._id + "/errors", admin);
  check("error file lists line, column, reason", errFile.status === 200 && errFile.data.csv.includes("3,atmId") && errFile.data.csv.includes("4,cashCount"));
  const imp2 = await call("/api/imports", admin, "POST", { template: "TXN-daily", fileName: "txn2.csv", csv: "atmId,date,cashCount,cashAmount\n" + A + ",30/09/2026,12,6000" });
  const t30 = (await call("/api/ops/txn?month=2026-09", admin)).data.rows.filter((r) => r.atmId === A && r.date === "2026-09-30");
  check("re-import replaces the same ATM-day", imp2.data.batch.accepted === 1 && t30.length === 1 && t30[0].cashCount === 12);
  check("franchisee cannot import company-wide file", (await call("/api/imports", fran, "POST", { template: "TXN-daily", csv })).status === 403);
  const impB = await call("/api/imports", adminB, "POST", { template: "TXN-daily", csv });
  check("company B import cannot write company A ATM", impB.status === 200 && impB.data.batch.accepted === 0);
  const cbrCsv = "atmId,date,deno,openingNotes,openingAmount\n" + A + ",2026-09-30,100,10,1000\n" + A + ",2026-09-30,500,10,4000";
  const impC = await call("/api/imports", admin, "POST", { template: "CBR-1", csv: cbrCsv });
  check("CBR-1 import checks notes × deno per line", impC.data.batch.accepted === 1 && impC.data.batch.rejected === 1);

  check("franchisee logs overage for own ATM", (await call("/api/ops/overage", fran, "POST", { atmId: A, date: "2026-09-29", amount: 500, mode: "UPI", utr: "U" + stamp })).status === 200);
  check("same UTR cannot be logged twice", (await call("/api/ops/overage", admin, "POST", { atmId: A, date: "2026-09-29", amount: 500, utr: "U" + stamp })).status === 409);
  check("session restores via /api/auth/me", (await call("/api/auth/me", fran)).data.user?.login === "franchisee@demo.local");
  check("company B cannot log overage on company A ATM", (await call("/api/ops/overage", adminB, "POST", { atmId: A, date: "2026-09-29", amount: 500 })).status === 400);
  const opsAudit = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check("audit has EODVerified, EODLocked, EODAdminCorrected, TXNImported, OverageDepositLogged", ["EODVerified", "EODLocked", "EODAdminCorrected", "TXNImported", "OverageDepositLogged"].every((x) => opsAudit.includes(x)));

  // Phase 2 slice 3: complaints / docket, Sales Officer visit, inspection
  const so = await login("so@demo.local", "Sales@123");
  const insp = await login("inspector@demo.local", "Insp@123");
  const soId = await findUser(admin, "so@demo.local");
  const inspId = await findUser(admin, "inspector@demo.local");
  check("field staff is not office admin (cannot approve applications)", (await call("/api/applications/" + sb.data.id, so, "PATCH", { approve: true })).status === 403);
  check("field staff cannot create ATM", (await call("/api/atms", so, "POST", { atmId: "SO" + stamp, atmSerialNumber: "S", machineTypeModel: "M" })).status === 403);

  const raise = (tok, body) => call("/api/complaints", tok, "POST", { atmId: A, problemType: "Dispenser", subject: "cash not dispensing", ...body });
  const t1c = await raise(fran, { priority: "Critical", description: "पैसे नहीं निकल रहे" });
  check("franchisee raises complaint and gets docket", t1c.status === 200 && /^DKT-DEXTER-\d{6}-\d{4}$/.test(t1c.data.docketNumber));
  const tid = t1c.data.id;
  check("duplicate open complaint rejected with existing docket", (await raise(fran)).status === 409);
  check("invalid ATM rejected", (await raise(fran, { atmId: "NOPE-" + stamp })).status === 400);
  check("company B cannot raise on company A ATM", (await raise(adminB)).status === 400);
  check("field staff cannot raise complaints", (await raise(so, { problemType: "Print" })).status === 403);
  const tk1 = (await call("/api/complaints/" + tid, fran)).data.complaint;
  check("franchisee priority fixed at Medium with SLA due date", tk1 && tk1.priority === "Medium" && !!tk1.dueAt && tk1.channel === "App");
  check("company B cannot see the complaint", (await call("/api/complaints/" + tid, adminB)).status === 404);
  check("unassigned Sales Officer cannot open the complaint", (await call("/api/complaints/" + tid, so)).status === 403);
  check("franchisee cannot assign", (await call("/api/complaints/" + tid, fran, "PATCH", { action: "assign", ownerName: "x" })).status === 403);
  check("desk assigns with SSM / RM and raises priority", (await call("/api/complaints/" + tid, admin, "PATCH", { action: "assign", ownerName: "Desk A", ssm: "SSM One", rm: "RM One", priority: "High" })).status === 200);
  check("desk escalates to SSM", (await call("/api/complaints/" + tid, admin, "PATCH", { action: "escalate", remark: "no response" })).status === 200);
  const t2 = (await call("/api/complaints/" + tid, admin)).data.complaint;
  check("ticket shows Escalated level 1 and High priority", t2.status === "Escalated" && t2.escalationLevel === 1 && t2.priority === "High");

  check("Inspector cannot be a visit officer", (await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: inspId, scheduledAt: "2026-10-01T10:00" })).status === 400);
  const v1 = await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: soId, scheduledAt: "2026-10-01T10:00" });
  check("desk schedules Sales Officer visit", v1.status === 200);
  check("only one open visit per ticket", (await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: soId, scheduledAt: "2026-10-02T10:00" })).status === 409);
  check("Sales Officer sees assigned ticket", (await call("/api/complaints", so)).data.complaints.some((x) => x._id === tid));
  check("reschedule needs reason", (await call("/api/visits/" + v1.data.id, admin, "PATCH", { action: "reschedule", scheduledAt: "2026-10-01T12:00" })).status === 400);
  check("desk reschedules with reason", (await call("/api/visits/" + v1.data.id, admin, "PATCH", { action: "reschedule", scheduledAt: "2026-10-01T12:00", reason: "SO in traffic" })).status === 200);
  check("visit cannot submit before check-in", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "submit", outcome: "Resolved" })).status === 400);
  check("another user cannot check in", (await call("/api/visits/" + v1.data.id, insp, "PATCH", { action: "checkIn" })).status === 403);
  check("Sales Officer checks in with GPS", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "checkIn", lat: "22.7", lng: "75.8" })).status === 200);
  check("wrong ATM ID on site rejected", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "update", atmConfirmed: true, atmIdSeen: "WRONG" })).status === 400);
  check("visit photo upload", (await call("/api/documents", so, "POST", { parentType: "visit", parentId: v1.data.id, type: "Visit photo", fileName: "v.jpg", data: b64("v"), lat: "22.7", lng: "75.8" })).status === 200);
  await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "update", atmConfirmed: true, atmIdSeen: A, findings: "dispenser belt broken" });
  check("submit needs check-out", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "submit", outcome: "Awaiting Spare" })).status === 400);
  await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "checkOut", lat: "22.7", lng: "75.8" });
  check("visit submitted as Awaiting Spare", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "submit", outcome: "Awaiting Spare" })).status === 200);
  check("ticket follows visit: Awaiting Spare", (await call("/api/complaints/" + tid, admin)).data.complaint.status === "Awaiting Spare");
  check("submitted visit is locked", (await call("/api/visits/" + v1.data.id, so, "PATCH", { action: "update", remarks: "x" })).status === 400);
  check("no photos on a submitted visit", (await call("/api/documents", so, "POST", { parentType: "visit", parentId: v1.data.id, type: "Visit photo", fileName: "v.jpg", data: b64("v") })).status === 400);

  const v2 = await call("/api/complaints/" + tid + "/visits", admin, "POST", { officerId: soId, scheduledAt: "2026-10-03T10:00" });
  await call("/api/visits/" + v2.data.id, so, "PATCH", { action: "checkIn" });
  await call("/api/visits/" + v2.data.id, so, "PATCH", { action: "checkOut", atmConfirmed: true, atmIdSeen: A, findings: "belt replaced, test withdrawal ok" });
  check("follow-up visit on same ticket resolves it", (await call("/api/visits/" + v2.data.id, so, "PATCH", { action: "submit", outcome: "Resolved" })).status === 200);
  const t3 = (await call("/api/complaints/" + tid, fran)).data;
  check("ticket Resolved with resolution from visit; 2 visits on same ticket", t3.complaint.status === "Resolved" && t3.complaint.resolution.includes("belt replaced") && t3.visits.length === 2);
  check("close needs closure remarks", (await call("/api/complaints/" + tid, fran, "PATCH", { action: "status", status: "Closed" })).status === 400);
  check("franchisee confirms and closes", (await call("/api/complaints/" + tid, fran, "PATCH", { action: "status", status: "Closed", closureRemarks: "working now" })).status === 200);
  check("franchisee reopens with reason", (await call("/api/complaints/" + tid, fran, "PATCH", { action: "status", status: "Reopened", remark: "failed again" })).status === 200);
  check("resolve needs resolution details", (await call("/api/complaints/" + tid, admin, "PATCH", { action: "status", status: "Resolved" })).status === 400);
  await call("/api/complaints/" + tid, admin, "PATCH", { action: "status", status: "Resolved", resolution: "cassette reseated" });
  check("desk closes resolved ticket", (await call("/api/complaints/" + tid, admin, "PATCH", { action: "status", status: "Closed", closureRemarks: "verified by call" })).status === 200);
  const t4 = (await call("/api/complaints/" + tid, admin)).data.complaint;
  check("full history kept", t4.history.length >= 10 && t4.history[0].action === "Created");
  check("new complaint allowed once previous is closed", (await raise(fran)).status === 200);
  check("franchisee cannot change SLA", (await call("/api/service/sla", fran, "PATCH", { Critical: 2 })).status === 403);
  check("Admin changes SLA hours", (await call("/api/service/sla", admin, "PATCH", { Critical: 2 })).status === 200 && (await call("/api/service/meta", admin)).data.slaHours.Critical === 2);

  check("franchisee cannot assign inspection", (await call("/api/inspections", fran, "POST", { atmId: A, date: "2026-09-30", officerId: inspId })).status === 403);
  const in1 = await call("/api/inspections", admin, "POST", { atmId: A, date: "2026-09-30", type: "Routine", officerId: inspId });
  check("desk assigns inspection", in1.status === 200);
  check("same ATM, date and type rejected", (await call("/api/inspections", admin, "POST", { atmId: A, date: "2026-09-30", type: "Routine", officerId: inspId })).status === 409);
  const iid = in1.data.id;
  const full = (fail) => (meta2) => meta2.checklist.map((item, i) => ({ item, result: i === 0 && fail ? "Fail" : "Pass", remark: "" }));
  const sm2 = (await call("/api/service/meta", insp)).data;
  check("inspection submit needs check-in", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "submit", checklist: full(false)(sm2) })).status === 400);
  await call("/api/inspections/" + iid, insp, "PATCH", { action: "checkIn", lat: "22.7", lng: "75.8" });
  check("checklist must be complete", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "submit", checklist: [] })).status === 400);
  check("failed item needs a remark", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "submit", checklist: full(true)(sm2) })).status === 400);
  const failList = full(true)(sm2);
  failList[0].remark = "signage torn";
  check("inspection needs a photo", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "submit", checklist: failList })).status === 400);
  check("other officer cannot add photo", (await call("/api/documents", so, "POST", { parentType: "inspection", parentId: iid, type: "Inspection photo", fileName: "i.jpg", data: b64("i") })).status === 403);
  await call("/api/documents", insp, "POST", { parentType: "inspection", parentId: iid, type: "Inspection photo", fileName: "i.jpg", data: b64("i"), lat: "22.7", lng: "75.8" });
  check("inspection submitted with Fail result", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "submit", checklist: failList })).status === 200);
  check("inspector cannot verify own inspection", (await call("/api/inspections/" + iid, insp, "PATCH", { action: "verify" })).status === 403);
  check("Admin verifies inspection", (await call("/api/inspections/" + iid, admin, "PATCH", { action: "verify" })).status === 200);
  const inRow = (await call("/api/inspections", admin)).data.inspections.find((x) => x._id === iid);
  check("inspection Verified, result Fail, GPS stored", inRow && inRow.status === "Verified" && inRow.result === "Fail" && inRow.gps && inRow.gps.lat === "22.7");
  check("Inspector sees only own inspections", (await call("/api/inspections", insp)).data.inspections.every((x) => x.officerId === inspId));

  const inCsv = ["atmId,date,officer,type", A + ",2026-10-01,inspector@demo.local,Surprise", A + ",2026-10-01,admin@demo.local,Routine", "NOPE,2026-10-01,inspector@demo.local,Routine"].join("\n");
  check("Sub Admin cannot import inspection list", (await call("/api/imports", sub, "POST", { template: "inspection-list", csv: inCsv })).status === 403);
  const inImp = await call("/api/imports", admin, "POST", { template: "inspection-list", csv: inCsv });
  check("Admin imports inspection list (good rows in, bad rows out)", inImp.status === 200 && inImp.data.batch.accepted === 1 && inImp.data.batch.rejected === 2);
  const hist = (await call("/api/service/atm-history/" + A, admin)).data;
  check("ATM history links complaints, visits, inspections", hist.complaints.length >= 2 && hist.visits.length >= 2 && hist.inspections.length >= 2);
  const svcAudit = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check(
    "audit has TicketCreated, Assigned, Escalated, VisitCheckIn, VisitSubmitted, Closed, InspectionSubmitted, InspectionVerified, InspectionListImported",
    ["TicketCreated", "Assigned", "Escalated", "VisitCheckIn", "VisitSubmitted", "Closed", "InspectionSubmitted", "InspectionVerified", "InspectionListImported"].every((x) => svcAudit.includes(x))
  );

  // Phase 2 slice 4: failed TXN / charge-back and finance
  const fin = await login("finance@demo.local", "Fin@123");
  const frId = (await call("/api/auth/me", fran)).data.user.franchiseId;
  const oth = otherNode.data.id;
  const othName = "Smoke Other " + stamp;
  const CB = "CB-" + stamp;
  const pdf = { fileName: "p.pdf", mime: "application/pdf", data: b64("proof") };
  await call("/api/atms", admin, "POST", { atmId: CB, atmSerialNumber: "SN-CB", machineTypeModel: "NCR", franchiseId: oth });

  const cbBody = { kind: "Charge back", atmId: CB, complaintDate: "2026-09-20", complainant: "card holder", txnDate: "2026-09-18", txnTime: "14:05", txnAmount: 2000, disputeAmount: 2000, cardNumber: "4111 1111 1111 1111", tlfRrn: "RRN" + stamp };
  check("franchisee cannot log charge-back", (await call("/api/finance/chargebacks", fran, "POST", cbBody)).status === 403);
  const cb1 = await call("/api/finance/chargebacks", fin, "POST", cbBody);
  check("Finance logs charge-back", cb1.status === 200);
  check("same ATM + RRN rejected", (await call("/api/finance/chargebacks", fin, "POST", cbBody)).status === 409);
  check("dispute above TXN amount rejected", (await call("/api/finance/chargebacks", fin, "POST", { ...cbBody, tlfRrn: "X" + stamp, disputeAmount: 3000 })).status === 400);
  check("TXN date after complaint rejected", (await call("/api/finance/chargebacks", fin, "POST", { ...cbBody, tlfRrn: "Y" + stamp, txnDate: "2026-09-25" })).status === 400);
  const cbRow = (await call("/api/finance/chargebacks", admin)).data.rows.find((r) => r._id === cb1.data.id);
  check("card stored masked only; pending-since shown", cbRow && cbRow.cardMasked === "411111******1111" && !JSON.stringify(cbRow).includes("4111111111111111") && cbRow.pendingSinceDays >= 0);
  check("Open charge-back cannot jump to Closed", (await call("/api/finance/chargebacks/" + cb1.data.id, fin, "PATCH", { status: "Closed" })).status === 400);
  check("charge-back accepted", (await call("/api/finance/chargebacks/" + cb1.data.id, fin, "PATCH", { status: "Accepted" })).status === 200);

  check("franchisee cannot create security deposit", (await call("/api/finance/security-deposits", fran, "POST", { franchiseId: frId, amountDue: 1 })).status === 403);
  const sd = await call("/api/finance/security-deposits", fin, "POST", { franchiseId: oth, amountDue: 100000 });
  check("Finance creates security deposit", sd.status === 200);
  const pay = (body) =>
    call("/api/finance/payments", fin, "POST", { kind: "SD", securityDepositId: sd.data.id, type: "NEFT", bank: "HDFC", account: "123456789", ifsc: "HDFC0001234", amount: 40000, paidAt: "2026-09-20T10:00", txnNumber: "UTRA" + stamp, file: pdf, ...body });
  check("payment needs proof file", (await pay({ file: null })).status === 400);
  check("bad IFSC rejected", (await pay({ ifsc: "XX1" })).status === 400);
  const p1 = await pay({});
  check("SD payment submitted", p1.status === 200);
  check("same UTR rejected", (await pay({})).status === 409);
  check("franchisee cannot pay another franchise's deposit", (await call("/api/finance/payments", fran, "POST", { kind: "SD", securityDepositId: sd.data.id, type: "NEFT", bank: "B", account: "1", ifsc: "HDFC0001234", amount: 1, paidAt: "2026-09-20T10:00", txnNumber: "Z" + stamp, file: pdf })).status === 400);
  check("person who entered payment cannot verify it", (await call("/api/finance/payments/" + p1.data.id, fin, "PATCH", { action: "approve" })).status === 403);
  check("settle before approval blocked", (await call("/api/finance/payments/" + p1.data.id, fin, "PATCH", { action: "settle" })).status === 400);
  await call("/api/finance/payments/" + p1.data.id, admin, "PATCH", { action: "approve" });
  check("Finance settles approved payment", (await call("/api/finance/payments/" + p1.data.id, fin, "PATCH", { action: "settle" })).status === 200);
  const sdRow1 = (await call("/api/finance/security-deposits", admin)).data.rows.find((r) => r._id === sd.data.id);
  check("SD Partially Received after first settlement", sdRow1.status === "Partially Received" && sdRow1.received === 40000 && sdRow1.balance === 60000);
  const p2 = await pay({ amount: 60000, txnNumber: "UTRB" + stamp });
  await call("/api/finance/payments/" + p2.data.id, admin, "PATCH", { action: "approve" });
  await call("/api/finance/payments/" + p2.data.id, fin, "PATCH", { action: "settle" });
  const sdRow2 = (await call("/api/finance/security-deposits", admin)).data.rows.find((r) => r._id === sd.data.id);
  check("SD Received when fully settled", sdRow2.status === "Received" && sdRow2.balance === 0);
  check("fully received SD takes no more payments", (await pay({ txnNumber: "UTRC" + stamp })).status === 400);
  check("no files added to a settled payment", (await call("/api/documents", fin, "POST", { parentType: "payment", parentId: p1.data.id, type: "x", fileName: "x", data: b64("x") })).status === 400);
  const clfBody = { kind: "CLF", atmId: CB, hpyAccount: "HPY-1", settlementBank: "Axis Indent", amount: 5000, paidAt: "2026-09-21T10:00", txnNumber: "UTRCLF" + stamp, file: pdf };
  check("CLF needs a listed settlement bank", (await call("/api/finance/payments", fin, "POST", { ...clfBody, settlementBank: "Paytm" })).status === 400);
  check("CLF payment submitted", (await call("/api/finance/payments", fin, "POST", clfBody)).status === 200);

  const bsPrior = (await call("/api/finance/bank-statements?fy=2026-27", fran)).data.rows.find((r) => r.month === "2026-08");
  if (bsPrior && bsPrior.financeStatus === "Checked") {
    check("franchisee cannot overwrite a Checked statement", (await call("/api/finance/bank-statements", fran, "POST", { month: "2026-08", file: pdf })).status === 400);
    check("Finance re-uploads a Checked statement", (await call("/api/finance/bank-statements", fin, "POST", { franchiseId: frId, month: "2026-08", file: pdf })).status === 200);
  } else check("franchisee uploads own bank statement", (await call("/api/finance/bank-statements", fran, "POST", { month: "2026-08", file: pdf })).status === 200);
  check("future-month statement rejected", (await call("/api/finance/bank-statements", fran, "POST", { month: "2099-01", file: pdf })).status === 400);
  const bs = (await call("/api/finance/bank-statements?fy=2026-27", fran)).data;
  const bsRow = bs.rows.find((r) => r.month === "2026-08");
  check("statement listed; missing months in pending list", bsRow && bsRow.uploadStatus === "Uploaded" && bs.pending.some((p) => p.month === "2026-04"));
  check("franchisee cannot set Finance A/C status", (await call("/api/finance/bank-statements/" + bsRow._id, fran, "PATCH", { financeStatus: "Checked" })).status === 403);
  check("query needs a remark", (await call("/api/finance/bank-statements/" + bsRow._id, fin, "PATCH", { financeStatus: "Query" })).status === 400);
  check("Finance marks statement Checked", (await call("/api/finance/bank-statements/" + bsRow._id, fin, "PATCH", { financeStatus: "Checked" })).status === 200);

  check("bad F.Y. rejected", (await call("/api/finance/tds", fin, "POST", { franchiseId: frId, fy: "2026-28", quarter: "Q1", file: pdf })).status === 400);
  check("Finance uploads TDS letter", (await call("/api/finance/tds", fin, "POST", { franchiseId: frId, fy: "2026-27", quarter: "Q1", file: pdf })).status === 200);
  check("franchisee cannot upload TDS", (await call("/api/finance/tds", fran, "POST", { fy: "2026-27", quarter: "Q2", file: pdf })).status === 403);
  const tdsRow = (await call("/api/finance/tds", fran)).data.rows.find((r) => r.fy === "2026-27" && r.quarter === "Q1");
  check("franchisee downloads own TDS letter", tdsRow && (await call("/api/documents/" + tdsRow.files[0]._id + "/file", fran)).status === 200);

  const gstBody = { franchiseId: oth, month: "2026-09", gstin: "27ABCDE1234F1Z5", grossAmount: 50000, tds: 1000, dispute: 500 };
  check("bad GSTIN rejected", (await call("/api/finance/gst-bills", fin, "PUT", { ...gstBody, gstin: "123" })).status === 400);
  const gb = await call("/api/finance/gst-bills", fin, "PUT", gstBody);
  check("GST bill net = gross + GST − TDS − shortage − dispute − charge-back", gb.status === 200 && gb.data.net === 55500);
  check("deducted charge-back is locked", (await call("/api/finance/chargebacks/" + cb1.data.id, fin, "PATCH", { remark: "x" })).status === 400);
  const gb2 = await call("/api/finance/gst-bills", fin, "PUT", gstBody);
  check("regenerating keeps the same bill and charge-back", gb2.status === 200 && gb2.data.billNo === gb.data.billNo && gb2.data.net === 55500);
  check("submit needs signed copy", (await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "submit" })).status === 400);
  check("signed bill submitted", (await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "submit", file: pdf })).status === 200);
  check("cannot regenerate after submit", (await call("/api/finance/gst-bills", fin, "PUT", gstBody)).status === 400);
  await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "process" });
  check("Paid needs UTR", (await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "complete" })).status === 400);
  check("bill Completed with UTR", (await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "complete", utr: "GSTUTR" + stamp })).status === 200);
  check("completed bill locked", (await call("/api/finance/gst-bills/" + gb.data.id, fin, "PATCH", { action: "pending", pendingAt: "Pending at FR End", remark: "x" })).status === 400);
  const eodsFr = (await call("/api/ops/eod", admin)).data.rows.filter((r) => r.franchiseId === frId && r.status === "Verified" && r.date.startsWith("2026-09"));
  const expShort = eodsFr.reduce((s, e) => s + (e.shortage || 0), 0);
  const gf = await call("/api/finance/gst-bills", fin, "PUT", { franchiseId: frId, month: "2026-09", gstin: "27ABCDE1234F1Z5", grossAmount: 10000000 });
  const gfRow = (await call("/api/finance/gst-bills", admin)).data.rows.find((r) => r._id === gf.data.id);
  check("GST shortage = Verified EOD shortage of franchise ATMs for the month", gf.status === 200 && gfRow.deductions.shortage === expShort && expShort >= 10000);

  const acct = { accountName: "Demo Franchisee", accountNumber: "123456789012", ifsc: "SBIN0001234", pan: "ABCDE1234F", bank: "SBI", file: pdf };
  check("bad PAN rejected", (await call("/api/finance/payout-accounts", fran, "PUT", { ...acct, pan: "123" })).status === 400);
  const pa = await call("/api/finance/payout-accounts", fran, "PUT", acct);
  check("franchisee submits payout account", pa.status === 200);
  check("Finance cannot verify payout account (Admin only)", (await call("/api/finance/payout-accounts/" + pa.data.id, fin, "PATCH", { action: "verify" })).status === 403);
  check("Admin verifies payout account", (await call("/api/finance/payout-accounts/" + pa.data.id, admin, "PATCH", { action: "verify" })).status === 200);
  const paOth = await call("/api/finance/payout-accounts", fin, "PUT", { ...acct, franchiseId: oth, accountName: othName });

  const frPayoutsBefore = (await call("/api/finance/payouts", admin)).data.rows.filter((r) => r.franchiseId === frId).length;
  const badPayout = await call("/api/imports", fin, "POST", { template: "payout", csv: "franchise,month,amount\nDemo Franchisee,2026-10,15000\n" + othName + ",2026-10,5000" });
  const frPayoutsAfter = (await call("/api/finance/payouts", admin)).data.rows.filter((r) => r.franchiseId === frId).length;
  check("payout import is all-or-nothing (unverified account rejects whole file)", badPayout.status === 200 && badPayout.data.batch.accepted === 0 && badPayout.data.batch.rejected === 2 && frPayoutsAfter === frPayoutsBefore);
  check("franchisee cannot import payouts", (await call("/api/imports", fran, "POST", { template: "payout", csv: "franchise,month,amount\nx,2026-10,1" })).status === 403);
  await call("/api/finance/payout-accounts/" + paOth.data.id, admin, "PATCH", { action: "verify" });
  const goodPayout = await call("/api/imports", fin, "POST", { template: "payout", csv: "franchise,month,amount,remark\n" + othName + ",2026-10,5000,Oct payout" });
  check("payout import accepted when every row is valid", goodPayout.data.batch.accepted === 1 && goodPayout.data.batch.rejected === 0);
  check("same franchise + month cannot be imported twice", (await call("/api/imports", fin, "POST", { template: "payout", csv: "franchise,month,amount\n" + othName + ",2026-10,5000" })).data.batch.accepted === 0);
  const po = (await call("/api/finance/payouts", admin)).data.rows.find((r) => r.franchiseName === othName);
  check("importer cannot approve own payout", (await call("/api/finance/payouts/" + po._id, fin, "PATCH", { status: "Approved" })).status === 403);
  check("Admin approves payout", (await call("/api/finance/payouts/" + po._id, admin, "PATCH", { status: "Approved" })).status === 200);
  check("franchisee cannot move payout", (await call("/api/finance/payouts/" + po._id, fran, "PATCH", { status: "Processing" })).status >= 403);
  check("Approved cannot jump to Paid", (await call("/api/finance/payouts/" + po._id, fin, "PATCH", { status: "Paid", utr: "U" })).status === 400);
  await call("/api/finance/payouts/" + po._id, fin, "PATCH", { status: "Processing" });
  check("Paid needs UTR", (await call("/api/finance/payouts/" + po._id, fin, "PATCH", { status: "Paid" })).status === 400);
  check("payout Paid with UTR", (await call("/api/finance/payouts/" + po._id, fin, "PATCH", { status: "Paid", utr: "PUTR" + stamp })).status === 200);
  check("franchisee cannot export", (await call("/api/finance/export?kind=payouts", fran)).status === 403);
  const exp = await call("/api/finance/export?kind=payouts", admin);
  check("Admin exports payouts CSV", exp.status === 200 && exp.data.csv.includes(othName) && exp.data.csv.includes("Paid"));
  const finAudit = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check(
    "audit has ChargeBackLogged, PaymentApproved, PaymentSettled, GSTBillGenerated, GSTBillStatusChanged, PayoutImported, PayoutStatusChanged, PayoutAccountVerified, BankStatementUploaded, TDSLetterUploaded",
    ["ChargeBackLogged", "PaymentApproved", "PaymentSettled", "GSTBillGenerated", "GSTBillStatusChanged", "PayoutImported", "PayoutStatusChanged", "PayoutAccountVerified", "BankStatementUploaded", "TDSLetterUploaded"].every((x) => finAudit.includes(x))
  );

  // Phase 2 slice 5: monthly / loading reports (ATM A: EOD 28 + 29 Sept, WLA + Axis funding 28 Sept, CBR 1 28 + 30 Sept)
  const rep = (tok, kind, q) => call("/api/reports/view/" + kind + "?month=2026-09&atmId=" + A + (q || ""), tok);
  check("franchisee cannot save monthly figures", (await call("/api/reports/monthly", fran, "PUT", { atmId: A, month: "2026-09", dmsBalance: 1 })).status === 403);
  check("future month rejected", (await call("/api/reports/monthly", admin, "PUT", { atmId: A, month: "2099-01" })).status === 400);
  check("bad funding model rejected", (await call("/api/reports/monthly", admin, "PUT", { atmId: A, month: "2026-09", fundingModel: "XX" })).status === 400);
  check("monthly DMS balance saved (FFM)", (await call("/api/reports/monthly", admin, "PUT", { atmId: A, month: "2026-09", fundingModel: "FFM", dmsBalance: 165000 })).status === 200);
  const ffm = (await rep(admin, "ffm-eod")).data;
  const ffmRow = ffm.rows.find((r) => r.atmId === A);
  check(
    "FFM EOD: title, month-end physical, DMS, overage, HPY fund, Apna dispense, actual balance",
    ffm.title === "Full Funding Sites - September 2026 - EOD Report 30.09.2026" &&
      ffmRow &&
      ffmRow.physEnd === 170000 &&
      ffmRow.dmsEnd === 165000 &&
      ffmRow.overEnd === 5000 &&
      ffmRow.givenFund === 573100 &&
      ffmRow.apnaDispense === 30000 &&
      ffmRow.actualBalance === 643100 &&
      ffm.columns.some((x) => x.en === "Machine Balance as per DMS @11:00 PM (31.08.2026)")
  );
  check("SF funding split saved", (await call("/api/reports/monthly", admin, "PUT", { atmId: A, month: "2026-09", fundingModel: "SF", selfFund: 150000, monthlyAdditional: 30000, weeklyAdditional: 20000 })).status === 200);
  const mon = (await call("/api/reports/monthly?month=2026-09", admin)).data.rows.find((r) => r.atmId === A);
  check("Total Funding = Self + Monthly + Weekly; DMS kept", mon && mon.totalFunding === 200000 && mon.dmsBalance === 165000);
  const sf = (await rep(admin, "sf-loading")).data;
  const sfRow = sf.rows.find((r) => r.atmId === A);
  check("SF Loading: overage = physical − (Total Funding − Apna dispense − WLA)", sfRow && sfRow.totalFunding === 200000 && sfRow.wlaEnd === 0 && sfRow.overEnd === -30000 && sfRow.settlementFund === 100000 && sf.note.includes("Weekly Additional"));
  check("SF site leaves FFM report", !(await rep(admin, "ffm-eod")).data.rows.some((r) => r.atmId === A));
  const mob = (await rep(fran, "mobile-app")).data.rows.find((r) => r.atmId === A);
  check("franchisee sees own Mobile APP card", mob && mob.eodEnd === 170000 && mob.givenFund === 573100 && mob.dispenseFund === 30000);
  check("company B sees no company A report rows", (await call("/api/reports/view/mobile-app?month=2026-09", adminB)).data.rows.every((r) => r.atmId !== A));
  const monCsv = ["atmId,month,dmsBalance", A + ",2026-08,1000", "NOPE-" + stamp + ",2026-09,5"].join("\n");
  const impM = await call("/api/imports", admin, "POST", { template: "monthly-atm", csv: monCsv });
  check("monthly import: before Cash Live and unknown ATM rejected", impM.status === 200 && impM.data.batch.accepted === 0 && impM.data.batch.rejected === 2);
  const impM2 = await call("/api/imports", admin, "POST", { template: "monthly-atm", csv: "atmId,month,dmsBalance\n" + A + ",2026-09,166000" });
  check("monthly import replaces same ATM + month", impM2.data.batch.accepted === 1 && (await call("/api/reports/monthly?month=2026-09", admin)).data.rows.find((r) => r.atmId === A).dmsBalance === 166000);
  check("franchisee cannot import monthly file", (await call("/api/imports", fran, "POST", { template: "monthly-atm", csv: monCsv })).status === 403);

  const dlr2 = (await rep(fran, "dlr2")).data;
  const d28 = dlr2.rows.find((r) => r.fundsDate === "28.09.2026");
  check(
    "DLR 2: funds received, WLA balance, 23:00 physical, Apna vs machine, loading with deno",
    d28 && d28.fundsReceived === 573100 && d28.wlaBalance === 0 && d28.physical === 80000 && d28.physicalDeno === "500×160" && d28.apnaDispense === 30000 && d28.machineDispense === 30000 && d28.loadingAmount === 100000 && d28.loadingDeno === "500×200"
  );
  check("DLR 2 headers bilingual", dlr2.columns.some((x) => x.hi === "लोडिंग तारीख"));
  const dlr3 = (await rep(fran, "dlr3")).data.rows.filter((r) => r.date === "28.09.2026");
  const d3tot = dlr3.find((r) => r.deno === "Total=");
  const d3100 = dlr3.find((r) => r.deno === 100);
  check("DLR 3: deno rows from CBR 1, Total= row, WLA and Apna columns", d3100 && d3100.opening === 20000 && d3100.dispensed === 30000 && d3tot && d3tot.opening === 620000 && d3tot.shortage === 600000 && d3tot.withdrawal === 150000 && d3tot.apnaDispense === 30000);
  const d3csv = await rep(admin, "dlr3", "&csv=1");
  check("DLR 3 CSV with Hindi header row", d3csv.status === 200 && d3csv.data.csv.includes("प्रारंभिक शेष") && d3csv.data.csv.includes(A));

  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  const loadBody = {
    atmId: A,
    date: today,
    lastDayFund: 5500,
    hpyFund: 500000,
    withdrawal: 400000,
    withdrawalNotes: { 100: 250, 200: 200, 500: 670 },
    rejectNotes: { 100: 15, 200: 10, 500: 6 },
    cassetteNotes: { 100: 27, 200: 16, 500: 55 },
    loadingNotes: { 100: 15, 200: 10, 500: 6 },
    wlaClosing: 105500,
  };
  check("withdrawal denominations must equal withdrawal", (await call("/api/reports/loading", fran, "PUT", { ...loadBody, withdrawalNotes: { 500: 1 } })).status === 400);
  check("future loading date rejected", (await call("/api/reports/loading", fran, "PUT", { ...loadBody, date: "2099-01-01" })).status === 400);
  check("loading on a verified EOD day blocked for franchisee", (await call("/api/reports/loading", fran, "PUT", { ...loadBody, date: "2026-09-29" })).status === 400);
  const ld = await call("/api/reports/loading", fran, "PUT", loadBody);
  check("franchisee saves daily loading; WLA closing = last day + HPY − withdrawal (Dexter-3 sample 105500)", ld.status === 200 && ld.data.wlaClosing === 105500);
  check("company B cannot enter loading for company A ATM", (await call("/api/reports/loading", adminB, "PUT", loadBody)).status === 400);
  check("wrong WLA closing still saves", (await call("/api/reports/loading", fran, "PUT", { ...loadBody, wlaClosing: 100000 })).status === 200);
  const mlFran = (await rep(fran, "mobile-loading")).data.rows.find((r) => r.date === today);
  const mlAdmin = (await rep(admin, "mobile-loading")).data.rows.find((r) => r.date === today);
  check("wrong calculation shown to Admin only", mlFran && mlFran.calcMismatch === undefined && mlAdmin && mlAdmin.calcMismatch === "Wrong calculation" && mlAdmin.withdrawalDeno === "100×250, 200×200, 500×670");
  check("flagged loading locked for franchisee", (await call("/api/reports/loading", fran, "PUT", loadBody)).status === 400);
  check("franchisee cannot correct loading", (await call("/api/reports/loading/" + mlAdmin._id + "/correct", fran, "PATCH", { reason: "x" })).status === 403);
  check("Admin correction needs a reason", (await call("/api/reports/loading/" + mlAdmin._id + "/correct", admin, "PATCH", {})).status === 400);
  check("Admin corrects loading", (await call("/api/reports/loading/" + mlAdmin._id + "/correct", admin, "PATCH", { reason: "FR keyed closing wrong" })).status === 200);
  const mlFixed = (await rep(admin, "mobile-loading")).data.rows.find((r) => r.date === today);
  check("correction clears the flag", mlFixed && mlFixed.calcMismatch === "" && mlFixed.wlaClosing === 105500 && mlFixed.adminCorrected === "FR keyed closing wrong");
  const repAudit = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check("audit has MonthlySaved, MonthlyImported, LoadingSaved, LoadingAdminCorrected, ReportExported", ["MonthlySaved", "MonthlyImported", "LoadingSaved", "LoadingAdminCorrected", "ReportExported"].every((x) => repAudit.includes(x)));

  // Phase 3 slice 1: tasks (CRM-06) and in-app notices
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inspUserId = await findUser(admin, "inspector@demo.local");
  const subId = sa.data.id;
  const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const tsk = (tok, body) => call("/api/tasks", tok, "POST", { title: "Smoke task " + stamp, dueAt: inHours(48), ...body });
  const move = (tok, id, to, extra) => call("/api/tasks/" + id, tok, "PATCH", { action: "status", to, ...extra });
  const taskOf = async (id, tok) => (await call("/api/tasks/" + id, tok || admin)).data.task;

  check("office Admin sets task profile", (await call("/api/tasks/profile/" + soId, admin, "PATCH", { team: "Field North", region: "Indore", skills: "ATM, Cash" })).status === 200);
  await call("/api/tasks/profile/" + inspUserId, admin, "PATCH", { team: "Field North", region: "Bhopal", skills: ["Audit"] });
  check("field staff cannot set profiles", (await call("/api/tasks/profile/" + soId, so, "PATCH", { team: "x" })).status === 403);
  check("franchisee cannot create tasks", (await tsk(fran, {})).status === 403);
  check("Sales Officer cannot create tasks", (await tsk(so, {})).status === 403);
  check("Lead source rejected", (await tsk(admin, { source: "Lead" })).status === 400);
  check("past due date rejected", (await tsk(admin, { dueAt: inHours(-1) })).status === 400);
  check("ATM outside company rejected", (await tsk(admin, { atmId: "NOPE-" + stamp })).status === 400);
  check("unknown skill cannot be assigned", (await tsk(admin, { assignSkill: "Welding" + stamp })).status === 400);

  const bySkill = await tsk(admin, { assignSkill: "audit", category: "Field", atmId: A });
  check("assign by skill picks matching user", bySkill.status === 200 && bySkill.data.assigneeName === "Demo Inspector");
  const pool = (await call("/api/tasks/assignees", admin)).data.users.filter((u) => ["so@demo.local", "inspector@demo.local"].includes(u.login));
  const lighter = pool.sort((a, b) => a.openTasks - b.openTasks || a.name.localeCompare(b.name))[0];
  const byTeam = await tsk(admin, { assignTeam: "Field North" });
  check("assign by team picks the least-loaded active member", byTeam.status === 200 && byTeam.data.assigneeName === lighter.name);

  const rv1 = await tsk(admin, { title: "Review flow " + stamp, assigneeId: soId, managerId: subId, priority: "High", atmId: A });
  check("task created with number and assignee", rv1.status === 200 && /^TSK-DEXTER-\d{6}-\d{4}$/.test(rv1.data.taskNo) && rv1.data.assigneeName === "Demo Sales Officer");
  const soNotes = (await call("/api/notices", so)).data;
  check("assignee gets in-app notice", soNotes.rows.some((n) => n.kind === "assignment" && n.title.includes(rv1.data.taskNo)) && soNotes.unread > 0);
  check("franchisee cannot see the task", (await call("/api/tasks/" + rv1.data.id, fran)).status === 404);
  check("company B cannot see the task", (await call("/api/tasks/" + rv1.data.id, adminB)).status === 404);
  check("assignee sees it under My tasks", (await call("/api/tasks?view=mine", so)).data.rows.some((t) => t._id === rv1.data.id));
  check("Assigned cannot jump to Completed", (await move(so, rv1.data.id, "Completed")).status === 400);
  check("only the assignee accepts", (await move(admin, rv1.data.id, "Accepted")).status === 403);
  await move(so, rv1.data.id, "Accepted");
  await move(so, rv1.data.id, "In Progress");
  check("hold needs a reason", (await move(so, rv1.data.id, "On Hold")).status === 400);
  check("review-required task cannot skip review", (await move(so, rv1.data.id, "Completed")).status === 400);
  check("assignee submits for review", (await move(so, rv1.data.id, "Submitted for Review")).status === 200);
  check("assignee cannot review own task", (await move(so, rv1.data.id, "Under Review")).status === 403);
  check("manager takes it under review", (await move(sub, rv1.data.id, "Under Review")).status === 200);
  check("rework needs a reason", (await move(sub, rv1.data.id, "Rework Required")).status === 400);
  await move(sub, rv1.data.id, "Rework Required", { reason: "photo missing" });
  await move(so, rv1.data.id, "In Progress");
  await move(so, rv1.data.id, "Submitted for Review");
  await move(sub, rv1.data.id, "Under Review");
  await move(sub, rv1.data.id, "Approved");
  check("assignee completes after approval", (await move(so, rv1.data.id, "Completed", { actualHours: 3 })).status === 200);
  check("assignee cannot close", (await move(so, rv1.data.id, "Closed")).status === 403);
  check("owner closes", (await move(admin, rv1.data.id, "Closed")).status === 200);
  const rv1Done = await taskOf(rv1.data.id);
  check("history, completion time, 100% and actual hours stored", rv1Done.status === "Closed" && rv1Done.percent === 100 && rv1Done.actualHours === 3 && rv1Done.completedAt && rv1Done.history.filter((h) => h.action === "Status").length >= 11);

  const rv2 = await tsk(admin, { title: "Reassign " + stamp, assigneeId: soId });
  check("reassign needs a reason", (await call("/api/tasks/" + rv2.data.id, admin, "PATCH", { action: "reassign", assigneeId: inspUserId })).status === 400);
  check("assignee cannot reassign", (await call("/api/tasks/" + rv2.data.id, so, "PATCH", { action: "reassign", assigneeId: inspUserId, reason: "x" })).status === 403);
  check("reassigned with reason", (await call("/api/tasks/" + rv2.data.id, admin, "PATCH", { action: "reassign", assigneeId: inspUserId, reason: "SO on leave" })).status === 200);
  const rv2r = await taskOf(rv2.data.id);
  check("assignment history kept", rv2r.assignments.length === 2 && rv2r.assigneeName === "Demo Inspector" && rv2r.assignments[1].reason === "SO on leave");
  check("inactive employee skipped", await (async () => {
    const tmpLogin = "tmp" + stamp + "@x";
    const tmp = await call("/api/users", admin, "POST", { login: tmpLogin, password: "Tmp@1234", name: "Tmp " + stamp, hierarchy: "SubAdmin" });
    await call("/api/users/" + tmp.data.id + "/activate", admin, "PATCH");
    await call("/api/employees", admin, "POST", { name: "Tmp " + stamp, employmentStatus: "Inactive", userId: tmp.data.id });
    return (await tsk(admin, { assigneeId: tmp.data.id })).status === 400;
  })());

  const parent = await tsk(admin, { title: "Parent " + stamp, assigneeId: soId, reviewRequired: false });
  const child = await tsk(admin, { title: "Child " + stamp, assigneeId: soId, reviewRequired: false, parentId: parent.data.id });
  for (const id of [parent.data.id, child.data.id]) {
    await move(so, id, "Accepted");
    await move(so, id, "In Progress");
  }
  check("parent cannot complete while a subtask is open", (await move(so, parent.data.id, "Completed")).status === 400);
  await move(so, child.data.id, "Completed");
  check("parent completes after subtasks (no review needed)", (await move(so, parent.data.id, "Completed")).status === 200);
  check("progress 0–100 only", (await call("/api/tasks/" + rv2.data.id, insp, "PATCH", { action: "progress", percent: 120 })).status === 400);
  check("assignee adds a note", (await call("/api/tasks/" + rv2.data.id, insp, "PATCH", { action: "note", text: "सामान आ गया" })).status === 200);

  check("Sub Admin cannot change task settings", (await call("/api/tasks/settings", sub, "PATCH", { missedPolicy: "Block Next" })).status === 403);
  await call("/api/tasks/settings", admin, "PATCH", { escalateAfterHours: { Critical: 0 } });
  const crit = await tsk(admin, { title: "Critical " + stamp, priority: "Critical", assigneeId: soId, managerId: subId, dueAt: new Date(Date.now() + 1500).toISOString() });
  const soon = await tsk(admin, { title: "Soon " + stamp, assigneeId: soId, dueAt: inHours(0.5) });
  await sleep(2000);
  await sweep(admin);
  const critAfter1 = await taskOf(crit.data.id);
  check("overdue task shown as Overdue and escalated to manager", critAfter1.displayStatus === "Overdue" && critAfter1.escalationLevel === 1);
  check("overdue view lists it", (await call("/api/tasks?view=overdue", admin)).data.rows.some((t) => t._id === crit.data.id));
  check("Sales Officer cannot run sweep", (await call("/api/system/sweep", so, "POST", {})).status === 403);
  await sweep(admin);
  check("then escalated to next level", (await taskOf(crit.data.id)).escalationLevel === 2);
  await call("/api/tasks/settings", admin, "PATCH", { escalateAfterHours: { Critical: 4 } });
  const subN = (await call("/api/notices", sub)).data.rows;
  const adminN = (await call("/api/notices", admin)).data.rows;
  const soN = (await call("/api/notices", so)).data.rows;
  check("manager gets level-1 escalation, Admin level 2", subN.some((n) => n.kind === "escalation" && n.title.includes("level 1")) && adminN.some((n) => n.kind === "escalation" && n.title.includes("level 2")));
  check("assignee gets breach and due-soon notices", soN.some((n) => n.kind === "sla-breach" && n.body.includes("Critical " + stamp)) && soN.some((n) => n.kind === "sla-warning" && n.body.includes("Soon " + stamp)));
  check("sweep does not repeat notices", (await sweep(admin)).data.tasks.escalated === 0);
  check("owner moves due date; overdue clears", (await call("/api/tasks/" + crit.data.id, admin, "PATCH", { action: "edit", dueAt: inHours(24) })).status === 200 && (await taskOf(crit.data.id)).displayStatus !== "Overdue");

  const ist = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);
  const tpl = (title) => call("/api/task-templates", admin, "POST", { title, frequency: "Daily", startDate: ist(-2), dueHours: 8, assigneeId: inspUserId });
  const count = async (q) => (await call("/api/tasks?view=all&q=" + encodeURIComponent(q), admin)).data.rows;
  check("template needs a frequency", (await call("/api/task-templates", admin, "POST", { title: "x" })).status === 400);
  await call("/api/tasks/settings", admin, "PATCH", { missedPolicy: "Independent Generation" });
  const tA = await tpl("RecInd" + stamp);
  await sweep(admin);
  await sweep(admin);
  const indRows = await count("RecInd" + stamp);
  check("Independent Generation: one task per missed day, no duplicates on rerun", indRows.length === 3 && indRows.every((t) => t.source === "Recurring" && t.assigneeName === "Demo Inspector"));
  await call("/api/tasks/settings", admin, "PATCH", { missedPolicy: "Block Next" });
  const tB = await tpl("RecBlk" + stamp);
  await sweep(admin);
  const blk = (await call("/api/task-templates", admin)).data.rows.find((x) => x._id === tB.data.id);
  check("Block Next: open instance blocks the next ones", (await count("RecBlk" + stamp)).length === 1 && blk.blockedCount === 2);
  await call("/api/tasks/settings", admin, "PATCH", { missedPolicy: "Carry Forward" });
  const tC = await tpl("RecCar" + stamp);
  await sweep(admin);
  const car = await count("RecCar" + stamp);
  check("Carry Forward: one task, later days carried into it", car.length === 1 && car[0].carryCount === 2);
  await call("/api/tasks/settings", admin, "PATCH", { missedPolicy: "Independent Generation" });
  check("pause a template", (await call("/api/task-templates/" + tA.data.id, admin, "PATCH", { status: "Paused" })).status === 200);
  for (const t of [tA, tB, tC]) await call("/api/task-templates/" + t.data.id, admin, "PATCH", { status: "Inactive" });

  const yesterday = ist(-1);
  check("EOD-unsubmitted notice lists ATMs without EOD", (await call("/api/notices?kind=eod", admin)).data.rows.some((n) => n.kind === "eod" && n.title.includes(yesterday) && n.body.includes("DEMO0001")));
  check("franchisee got stage-complete notices", (await call("/api/notices", fran)).data.rows.some((n) => n.kind === "stage"));
  const pendingAff = (await call("/api/reminders", fran)).data.affidavitPending || [];
  check("affidavit-pending notice when affidavits are missing", !pendingAff.length || (await call("/api/notices", fran)).data.rows.some((n) => n.kind === "affidavit"));
  await call("/api/service/sla", admin, "PATCH", { Critical: 0.0005 });
  const lateTicket = await call("/api/complaints", admin, "POST", { atmId: A, problemType: "Cash jam", subject: "jam", priority: "Critical" });
  await call("/api/service/sla", admin, "PATCH", { Critical: 4 });
  check("ticket assign notifies the owner", (await call("/api/complaints/" + lateTicket.data.id, admin, "PATCH", { action: "assign", ownerUserId: subId })).status === 200 && (await call("/api/notices", sub)).data.rows.some((n) => n.kind === "assignment" && n.title.startsWith("Ticket assigned")));
  await sleep(2500);
  await sweep(admin);
  check("ticket SLA breach notifies desk", (await call("/api/notices?kind=sla-breach", admin)).data.rows.some((n) => n.kind === "sla-breach" && n.title.includes(lateTicket.data.docketNumber || "DKT")));
  const oneNotice = (await call("/api/notices", so)).data.rows.find((n) => !n.read);
  check("others cannot mark my notice read", (await call("/api/notices/" + oneNotice._id + "/read", fran, "PATCH")).status === 404);
  const before = (await call("/api/notices", so)).data.unread;
  await call("/api/notices/" + oneNotice._id + "/read", so, "PATCH");
  check("mark read lowers unread count", (await call("/api/notices", so)).data.unread === before - 1);
  await call("/api/notices/read-all", so, "POST", {});
  check("read all", (await call("/api/notices", so)).data.unread === 0);

  check("Sub Admin cannot export tasks", (await call("/api/tasks/export", sub)).status === 403);
  const tExp = await call("/api/tasks/export", admin);
  check("Admin exports tasks CSV", tExp.status === 200 && tExp.data.csv.includes(rv1.data.taskNo));
  const taskAudit = (await call("/api/audit", admin)).data.events.map((e) => e.event);
  check("audit has TaskCreated, Assigned, StatusChanged, Reassigned, Escalated", ["TaskCreated", "Assigned", "StatusChanged", "Reassigned", "Escalated"].every((x) => taskAudit.includes(x)));

  // Phase 3 slice 2: dashboards (CRM-07) and Dexter-3 report screens
  const dash = (tok, kind, q) => call("/api/dashboard/" + kind + "?" + (q || ""), tok);
  check("field staff get no dashboards", (await dash(so, "complaints")).status === 403);
  check("unknown dashboard 404", (await dash(admin, "leads")).status === 404);
  const cA = (await dash(admin, "complaints", "atmId=" + A)).data;
  check(
    "complaint board: totals, overdue / SLA breach, overdue list, filter options",
    cA.totals.Total >= 2 && cA.totals.Overdue >= 1 && cA.totals["SLA breach"] >= 1 && cA.list.some((r) => r.docket === lateTicket.data.docketNumber) && cA.breakdowns["Open by category"].some((x) => x.key === "Cash jam")
  );
  check("complaint board filters by category", (await dash(admin, "complaints", "atmId=" + A + "&category=Cash%20jam")).data.totals.Total === 1);
  check("complaint board filters by owner", (await dash(admin, "complaints", "ownerUserId=" + subId)).data.list.every((r) => r.owner === "Sub " + stamp));
  check("franchisee board excludes other franchise ATM", (await dash(fran, "complaints", "atmId=" + CB)).data.totals.Total === 0);
  check("company B board never shows company A", (await dash(adminB, "complaints", "atmId=" + A)).data.totals.Total === 0);
  const newProj = await call("/api/projects", admin, "POST", { name: "Smoke P " + stamp });
  const atmRowA = (await call("/api/atms", admin)).data.atms.find((a) => a.atmId === A);
  const projB = (await call("/api/projects", adminB)).data.projects[0];
  check("ATM cannot join another company's project", !projB || (await call("/api/atms/" + atmRowA._id, admin, "PATCH", { projectId: projB._id })).status === 400);
  check("ATM tagged with company project", (await call("/api/atms/" + atmRowA._id, admin, "PATCH", { projectId: newProj.data.id })).status === 200);
  check("project filter narrows to that project's ATMs", (await dash(admin, "complaints", "projectId=" + newProj.data.id)).data.totals.Total === cA.totals.Total);
  const pj = (await dash(admin, "projects", "franchiseId=" + frId)).data;
  check("project board: Held / Active / Completed with Cash Live dates", pj.totals.Completed >= 1 && pj.list.some((p) => p.cashLive === "2026-09-28") && "Held" in pj.totals);
  check("project board by project shows the linked site", (await dash(admin, "projects", "projectId=" + newProj.data.id)).data.totals.Total === 1);
  check("project scope: franchisee on another project loses that ATM's tickets", !(await call("/api/complaints", fran)).data.complaints.some((c) => c.atmId === A));
  check("project scope: franchisee cannot raise on that ATM", (await raise(fran, { problemType: "Other", subject: "scope " + stamp })).status === 400);
  check("project scope: Admin still sees it", (await call("/api/complaints", admin)).data.complaints.some((c) => c.atmId === A));
  await call("/api/atms/" + atmRowA._id, admin, "PATCH", { projectId: "" });
  check("untagged ATM visible to franchisee again", (await call("/api/complaints", fran)).data.complaints.some((c) => c.atmId === A));
  const op29 = (await dash(admin, "ops", "atmId=" + A + "&date=2026-09-29")).data;
  check("ops board: EOD verified, TXN entered, CBR 1 missing on 29 Sept", op29.totals["Cash Live ATMs"] === 1 && op29.totals["EOD Verified"] === 1 && op29.totals["TXN entered"] === 1 && op29.totals["CBR 1 entered"] === 0);
  const op28 = (await dash(admin, "ops", "atmId=" + A + "&date=2026-09-28")).data;
  check("ops board: CBR 1 and CBR 2 complete on 28 Sept; Zero TXN counted", op28.totals["CBR 1 entered"] === 1 && op28.totals["CBR 2 entered"] === 1 && op28.list[0].zeroTxnDays === 1);
  check("wrong-calc count shown to Admin only", "Wrong WLA / indent calc (Admin)" in op28.totals && !("Wrong WLA / indent calc (Admin)" in (await dash(fran, "ops", "atmId=" + A + "&date=2026-09-28")).data.totals));
  const finB = (await dash(admin, "finance", "franchiseId=" + oth)).data;
  check("finance board: deposits, GST at FR vs operator, payouts on hold", "GST pending at FR" in finB.totals && "GST pending at operator" in finB.totals && "Payouts on hold" in finB.totals && finB.totals["Deposits pending"] === 0);
  check("franchisee finance board is own franchise only", (await dash(fran, "finance")).data.list.every((r) => r.franchise === "Demo Franchisee"));
  const tb = (await dash(admin, "tasks")).data;
  check("task board: workload by assignee, not a performance score", tb.totals.Open >= 1 && tb.breakdowns["Open by assignee"].length >= 1 && tb.insights.some((t) => t.includes("not a performance measure")));
  check("Sub Admin cannot export dashboards", (await dash(sub, "complaints", "csv=1")).status === 403);
  const dcsv = await dash(admin, "ops", "csv=1&atmId=" + A + "&date=2026-09-28");
  check("Admin exports dashboard CSV", dcsv.status === 200 && dcsv.data.csv.includes("Totals") && dcsv.data.csv.includes(A));

  const r1 = (await rep(admin, "cbr1")).data.rows.filter((r) => r.date === "28.09.2026");
  check("CBR 1 screen: deno lines and Total", r1.some((r) => r.deno === 100 && r.openingAmount === 20000 && r.dispensedNotes === 300) && r1.some((r) => r.deno === "Total" && r.openingAmount === 620000 && r.cra === "CRA-1"));
  check("CBR 2 screen", (await rep(admin, "cbr2")).data.rows.some((r) => r.date === "28.09.2026" && r.opening === 100000 && r.closing === 70000));
  const w3 = await rep(fran, "cbr3-wla");
  check("CBR 3 WLA screen; wrong-calc column hidden from franchisee", w3.data.rows.some((r) => r.closingWla === 0 && r.fundHpy === 100000) && !w3.data.columns.some((x) => x.key === "calcMismatch"));
  check("CBR 3 Axis screen shows Admin correction", (await rep(admin, "cbr3-axis")).data.rows.some((r) => r.axisLot1 === 473100 && r.adminCorrected === "CBR loading keyed short"));
  check("Overage Deposit screen", (await rep(fran, "overage")).data.rows.some((r) => r.utr === "U" + stamp && r.amount === 500 && r.attached === "No"));

  // Phase 3 slice 3: audit screen, session analytics, company switcher
  const aud = (q, tok) => call("/api/audit?" + (q || ""), tok || admin);
  const ls = (await aud("event=LoginSuccess&pageSize=5")).data;
  check("audit filters by event with total and paging", ls.events.length === 5 && ls.total >= 5 && ls.events.every((e) => e.event === "LoginSuccess"));
  const ls2 = (await aud("event=LoginSuccess&pageSize=5&page=2")).data;
  check("audit page 2 differs from page 1", ls2.events.length >= 1 && !ls2.events.some((e) => ls.events.some((x) => x._id === e._id)));
  check("audit filters by login", (await aud("login=franchisee")).data.events.every((e) => /franchisee/.test(e.login)));
  check("audit filters by module", (await aud("module=CRM-06")).data.events.every((e) => e.module === "CRM-06"));
  check("audit default still returns recent company events", (await aud()).data.events.length >= 1 && (await aud()).data.events.length <= 200);
  const meA = (await call("/api/auth/me", admin)).data.user;
  check("company B admin cannot read company A audit", (await aud("companyId=" + meA.companyId, adminB)).status === 403);
  check("franchisee cannot read audit", (await aud("", fran)).status === 403);
  check("audit meta lists events and users", (await call("/api/audit/meta", admin)).data.events.includes("LoginSuccess"));
  check("Sub Admin cannot export audit", (await call("/api/audit/export", sub)).status === 403);
  const acsv = await call("/api/audit/export?event=LoginSuccess", admin);
  check("Admin exports audit CSV with BOM", acsv.status === 200 && acsv.data.csv.startsWith("\uFEFFat_ist,event") && acsv.data.csv.includes("LoginSuccess"));
  check("retention under 30 days refused", (await call("/api/audit/settings", admin, "PATCH", { retentionDays: 10 })).status === 400);
  check("retention 45 days saved", (await call("/api/audit/settings", admin, "PATCH", { retentionDays: 45, hideIpFromNonAdmin: true })).status === 200);
  check("Sub Admin cannot change audit policy", (await call("/api/audit/settings", sub, "PATCH", { retentionDays: 60 })).status === 403);
  await call("/api/audit/settings", admin, "PATCH", { retentionDays: 30 });
  const auAudit = (await aud("pageSize=50")).data.events.map((e) => e.event);
  check("AuditExported and AuditSettingsChanged audited", auAudit.includes("AuditExported") && auAudit.includes("AuditSettingsChanged"));

  const franUserId = await findUser(admin, "franchisee@demo.local");
  const badTicket = (await call("/api/auth/login", null, "POST", { login: "franchisee@demo.local", password: "Fran@123" })).data.ticket;
  check("bad MFA refused", (await call("/api/auth/mfa", null, "POST", { ticket: badTicket, otp: "000000" })).status === 401);
  const franTmp = await login("franchisee@demo.local", "Fran@123");
  check("logout ok", (await call("/api/auth/logout", franTmp, "POST")).status === 200);
  check("logged-out token rejected", (await call("/api/auth/me", franTmp)).status === 401);
  const sess = (await call("/api/analytics/sessions", admin)).data;
  const franRow = sess.rows.find((r) => r.userId === franUserId);
  check("session analytics: logins, logouts, failed MFA per user", franRow && franRow.logins >= 2 && franRow.logouts >= 1 && franRow.failures >= 1);
  check("session analytics shows work next to time, with the not-productivity note", franRow && "workEvents" in franRow && "tasksCompleted" in franRow && /not a measure of productivity/.test(sess.note));
  const franSess = (await call("/api/analytics/sessions/" + franUserId, admin)).data.sessions;
  check("session list records how the session ended", franSess.some((s) => s.endReason === "Logout" && s.endAt) && franSess.some((s) => s.endReason === "Open"));
  check("franchisee cannot see everyone's sessions", (await call("/api/analytics/sessions", fran)).status === 403);
  const mineS = (await call("/api/analytics/sessions?view=mine", fran)).data.rows;
  check("franchisee sees own sessions only", mineS.length === 1 && mineS[0].userId === franUserId);
  check("franchisee cannot open another user's sessions", (await call("/api/analytics/sessions/" + meA.id, fran)).status === 403);
  const subView = (await call("/api/analytics/sessions", sub)).data;
  const adminIp = sess.rows.find((r) => r.userId === franUserId).lastIp;
  check("IP masked for non-Admin viewer by policy", subView.ipMasked === true && subView.rows.find((r) => r.userId === franUserId).lastIp !== adminIp);
  check("company B sees no company A sessions", !(await call("/api/analytics/sessions", adminB)).data.rows.some((r) => r.userId === franUserId));

  const dexCos = (await call("/api/companies", dexter)).data.companies;
  const meB = (await call("/api/auth/me", adminB)).data.user;
  check("Admin cannot switch company", (await call("/api/auth/company", admin, "POST", { companyId: meB.companyId })).status === 403);
  check("Dexter cannot switch to an ungranted company", (await call("/api/auth/company", dexter, "POST", { companyId: "000000000000000000000000" })).status === 403);
  const dexHome = (await call("/api/auth/me", dexter)).data.user;
  check("Dexter user can switch and has more than one company", dexHome.canSwitchCompany && dexCos.length >= 2);
  const sw = await call("/api/auth/company", dexter, "POST", { companyId: meB.companyId });
  check("Dexter switches to company B", sw.status === 200 && sw.data.user.companyId === meB.companyId && sw.data.user.homeCompanyId === dexHome.homeCompanyId);
  check("active company sticks to the session", (await call("/api/auth/me", dexter)).data.user.companyId === meB.companyId);
  check("company B audit shows the switch", (await aud("event=CompanySwitched", adminB)).data.events.some((e) => e.login === "dexter@demo.local"));
  check("after switch, Dexter sees company B data", (await call("/api/applications", dexter)).data.applications.length === (await call("/api/applications", adminB)).data.applications.length);
  const allCo = (await aud("companyId=all&pageSize=500", dexter)).data;
  check("Dexter audit across granted companies", new Set(allCo.events.map((e) => String(e.companyId))).size >= 2);
  await call("/api/auth/company", dexter, "POST", { companyId: dexHome.homeCompanyId });
  check("Dexter switches back home", (await call("/api/auth/me", dexter)).data.user.companyId === dexHome.homeCompanyId);

  // Rescan 4: security, crash guards, flow and data consistency
  check("Dexter cannot widen own company grants", (await call("/api/users/" + dexHome.id, dexter, "PATCH", { grantedCompanyIds: [] })).status === 403);
  check(
    "Dexter cannot grant a company they do not hold",
    (await call("/api/users", dexter, "POST", { login: "dx" + stamp + "@demo.local", password: "Dx@12345", name: "Dx", hierarchy: "DexterIndiaCompanyTeam", grantedCompanyIds: ["000000000000000000000000"] })).status === 403
  );
  check("Dexter's new company is granted to them", (await call("/api/companies", dexter)).data.companies.some((c) => c.code === "SM" + stamp));
  check(
    "Sub Admin cannot grant actions they lack",
    (await call("/api/users", sub, "POST", { login: "fx" + stamp + "@demo.local", password: "Fx@12345", name: "Fx", hierarchy: "Franchise", franchiseId: frId, actions: ["View", "Export"] })).status === 403
  );
  check("franchise user cannot hold the Verifier role", (await call("/api/users/" + franUserId, admin, "PATCH", { functionalRole: "Verifier" })).status === 400);
  check("Admin cannot change own role", (await call("/api/users/" + meA.id, admin, "PATCH", { hierarchy: "SubAdmin" })).status === 403);
  const rt = (await call("/api/auth/forgot", null, "POST", { login: "franchisee@demo.local" })).data;
  for (let i = 0; i < 5; i++) await call("/api/auth/reset", null, "POST", { ticket: rt.ticket, otp: "000000", password: "Nope@123" });
  check("reset code dies after 5 wrong tries", (await call("/api/auth/reset", null, "POST", { ticket: rt.ticket, otp: rt.otpDemo, password: "Nope@123" })).status === 401);
  await fetch(B + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": '=HYPERLINK("http://x/")' }, body: JSON.stringify({ login: "admin@demo.local", password: "wrong" }) });
  const inj = await call("/api/audit/export?event=LoginFailure&login=admin%40demo.local", admin);
  check("CSV export neutralises formula cells", inj.data.csv.includes("'=HYPERLINK") && !/,=HYPERLINK/.test(inj.data.csv));
  const badJson = await fetch(B + "/api/complaints", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + admin }, body: "{bad" });
  check("malformed JSON gets 400, not a crash", badJson.status === 400);
  check("impossible date on ops board does not crash", (await dash(admin, "ops", "date=2026-13-01")).status === 200 && (await call("/api/health", null)).status === 200);
  check("invalid franchise filter shows nothing", (await dash(admin, "complaints", "franchiseId=bad")).data.totals.Total === 0);
  check("template start date must be a real date", (await call("/api/task-templates", admin, "POST", { title: "Bad" + stamp, frequency: "Daily", startDate: "2026-00-10" })).status === 400);
  check("template cannot backfill more than 31 days", (await call("/api/task-templates", admin, "POST", { title: "Old" + stamp, frequency: "Daily", startDate: ist(-60) })).status === 400);
  check("Admin cannot add register columns to another company", (await call("/api/register-columns", admin, "POST", { companyId: meB.companyId, name: "X" })).status === 403);
  check("Admin cannot publish affidavit format to another company", (await call("/api/affidavit-formats", admin, "POST", { companyId: meB.companyId, model: "X", data: b64("x") })).status === 403);
  const resolved = (await call("/api/complaints?view=done", admin)).data.complaints.find((c) => c.status === "Resolved");
  check("Resolved ticket cannot slip back open without a reason", !resolved || (await call("/api/complaints/" + resolved._id, admin, "PATCH", { action: "status", status: "In Progress" })).status === 400);
  check("open view filters in the query", (await call("/api/complaints?view=open", admin)).data.complaints.every((c) => !["Resolved", "Closed"].includes(c.status)));
  const twin = { atmId: A, subject: "Twin " + stamp, problemType: "Other", priority: "Low" };
  const [tw1, tw2] = await Promise.all([call("/api/complaints", admin, "POST", twin), call("/api/complaints", admin, "POST", twin)]);
  check("double submit creates one complaint at most", !(tw1.status === 200 && tw2.status === 200) && [tw1.status, tw2.status].every((s) => s === 200 || s === 409));

  // Phase 3 slice 4: email tracker and templates
  const mt = await raise(fran, { problemType: "Display", subject: "screen blank " + stamp });
  const mtId = mt.data.id;
  const mtDocket = mt.data.docketNumber;
  const mMeta = (await call("/api/mail/meta", admin)).data;
  check("mail meta lists templates, six trackers and demo transport", mMeta.templates.length >= 5 && mMeta.variants.length === 6 && mMeta.transport === "demo");
  await call("/api/mail/mailbox", admin, "POST", { address: "" });
  check("send without a connected mailbox refused", (await call("/api/mail", admin, "POST", { complaintId: mtId, to: "fr@demo.local", subject: "x" })).status === 400);
  check("mailbox password never accepted", (await call("/api/mail/mailbox", admin, "POST", { address: "desk@demo.local", password: "x" })).status === 400);
  check("mailbox connects", (await call("/api/mail/mailbox", admin, "POST", { address: "desk@demo.local" })).data.mailbox.address === "desk@demo.local");
  check("bad address rejected", (await call("/api/mail", admin, "POST", { complaintId: mtId, to: "not-an-email", subject: "x" })).status === 400);
  const rnd = (await call("/api/mail/render", admin, "POST", { templateKey: "ack", complaintId: mtId })).data;
  check("ack template fills docket and ATM", rnd.subject.includes(mtDocket) && rnd.body.includes(A));
  const sent = await call("/api/mail", admin, "POST", { complaintId: mtId, templateKey: "ack", to: "fr@demo.local", bcc: "boss@demo.local", subject: rnd.subject, body: rnd.body });
  check("ticket mail sent with Message-ID", sent.status === 200 && sent.data.status === "Sent" && /^<.+@demo\.advocateflow>$/.test(sent.data.messageId));
  check("ticket history records the mail", (await call("/api/complaints/" + mtId, admin)).data.complaint.history.some((h) => h.action === "Mail sent"));
  const frThread = (await call("/api/mail?complaintId=" + mtId, fran)).data.rows;
  check("franchisee sees the thread without BCC", frThread.length === 1 && frThread[0].bcc === undefined);
  check("desk sees BCC", (await call("/api/mail?complaintId=" + mtId, admin)).data.rows[0].bcc[0] === "boss@demo.local");
  check("company B cannot read the thread", (await call("/api/mail?complaintId=" + mtId, adminB)).status === 404);
  check("unassigned Sales Officer cannot read the thread", (await call("/api/mail?complaintId=" + mtId, so)).status === 404);
  check("franchisee cannot compose office mail", (await call("/api/mail", fran, "POST", { complaintId: mtId, to: "a@b.co", subject: "x" })).status === 403);
  const bad = await call("/api/mail", admin, "POST", { complaintId: mtId, to: "x@fail.invalid", subject: "will fail" });
  check("undeliverable mail marked Failed", bad.data.status === "Failed");
  const rt1 = await call("/api/mail/" + bad.data.id, admin, "PATCH", { action: "retry" });
  const badRow = (await call("/api/mail?complaintId=" + mtId + "&status=Failed", admin)).data.rows.find((m) => m._id === bad.data.id);
  check("retry counted and audited", rt1.data.status === "Failed" && badRow.retries === 1 && (await aud("event=MailRetry", admin)).data.events.length > 0);
  check("only Failed mail can be retried", (await call("/api/mail/" + sent.data.id, admin, "PATCH", { action: "retry" })).status === 400);
  const dr = await call("/api/mail", admin, "POST", { complaintId: mtId, draft: true, subject: "draft " + stamp, file: { fileName: "d.txt", mime: "text/plain", data: b64("draft") } });
  check("draft saved without recipients", dr.data.status === "Draft");
  check("franchisee does not see drafts", !(await call("/api/mail?complaintId=" + mtId, fran)).data.rows.some((m) => m._id === dr.data.id));
  const drFile = (await call("/api/mail?complaintId=" + mtId, admin)).data.rows.find((m) => m._id === dr.data.id).files[0];
  check("franchisee cannot open a draft attachment", (await call("/api/documents/" + drFile._id + "/file", fran)).status === 404);
  check("draft cannot send without To", (await call("/api/mail/" + dr.data.id, admin, "PATCH", { action: "send" })).status === 400);
  check("draft edited then sent", (await call("/api/mail/" + dr.data.id, admin, "PATCH", { action: "send", to: "fr@demo.local" })).data.status === "Sent");
  check("sent mail cannot be edited", (await call("/api/mail/" + dr.data.id, admin, "PATCH", { action: "edit", subject: "x" })).status === 400);
  check("generic upload onto a mail refused", (await call("/api/documents", admin, "POST", { parentType: "mail", parentId: dr.data.id, type: "x", data: b64("x") })).status === 400);
  check("only this ticket's files can be attached", (await call("/api/mail", admin, "POST", { complaintId: mtId, to: "a@demo.local", subject: "x", attachmentIds: [drFile._id] })).status === 400);
  const inb = { from: "fr@demo.local", messageId: "<in1." + stamp + "@fr>", inReplyTo: sent.data.messageId, subject: "Re: whatever", body: "still blank", createTask: true };
  const mi1 = await call("/api/mail/inbound", admin, "POST", inb);
  check("reply mapped by In-Reply-To and task created", mi1.data.mapped && mi1.data.docketNumber === mtDocket && /Message/.test(mi1.data.mappedBy) && !!mi1.data.task);
  check("original mail marked Reply Received", (await call("/api/mail?complaintId=" + mtId, admin)).data.rows.find((m) => m._id === sent.data.id).status === "Reply Received");
  check("same Message-ID recorded once", (await call("/api/mail/inbound", admin, "POST", inb)).status === 409);
  const mi2 = await call("/api/mail/inbound", admin, "POST", { from: "fr@demo.local", messageId: "<in2." + stamp + "@fr>", subject: "About " + mtDocket, body: "" });
  check("reply mapped by docket in subject", mi2.data.mapped && /Docket/.test(mi2.data.mappedBy));
  const mi3 = await call("/api/mail/inbound", admin, "POST", { from: "fr@demo.local", messageId: "<in3." + stamp + "@fr>", subject: "screen blank " + stamp, body: "" });
  check("subject alone never maps", mi3.status === 200 && !mi3.data.mapped);
  check("unmapped mail listed for the desk", (await call("/api/mail?unmapped=1", admin)).data.rows.some((m) => m._id === mi3.data.id));
  check("desk maps it by docket", (await call("/api/mail/" + mi3.data.id + "/map", admin, "PATCH", { docketNumber: mtDocket })).status === 200);
  check("franchisee cannot record inbound mail", (await call("/api/mail/inbound", fran, "POST", { ...inb, messageId: "<x" + stamp + ">" })).status === 403);
  check("franchisee replies on own thread", (await call("/api/mail/" + sent.data.id + "/reply", fran, "POST", { body: "done now" })).status === 200);
  check("company B cannot reply on the thread", (await call("/api/mail/" + sent.data.id + "/reply", adminB, "POST", { body: "x" })).status === 404);
  check("franchisee cannot edit templates", (await call("/api/mail/templates/ack", fran, "PUT", { subject: "x", body: "y" })).status === 403);
  check("Admin saves template", (await call("/api/mail/templates/cbr", admin, "PUT", { name: "CBR", subject: "CBR {{atmId}} " + stamp, body: "Report for {{atmId}}" })).status === 200);
  check("saved template renders", (await call("/api/mail/render", admin, "POST", { templateKey: "cbr", atmId: A })).data.subject === "CBR " + A + " " + stamp);
  check("company B keeps its own template", !(await call("/api/mail/meta", adminB)).data.templates.find((t) => t.key === "cbr").subject.includes(String(stamp)));
  await call("/api/mail", admin, "POST", { atmId: A, templateKey: "cbr", to: "bank@demo.local", subject: "CBR " + A, body: "x" });
  const month = ist(0).slice(0, 7);
  const trk = (v, tok, q = "") => call("/api/mail/tracker/" + v + "?month=" + month + q, tok || admin);
  check("complaint tracker shows docket sent within 4 hours", (await trk("complaint")).data.rows.some((r) => r.docketNumber === mtDocket && r.docketIn4Hours === "Yes"));
  check("CBR mail tracker lists the CBR mail", (await trk("cbr")).data.rows.some((r) => r.atmId === A));
  check("penalty row needs a company ATM", (await call("/api/mail/tracker/penalty", admin, "POST", { atmId: "NOPE" + stamp, days: 1 })).status === 400);
  check("penalty days must be whole", (await call("/api/mail/tracker/penalty", admin, "POST", { atmId: A, days: 1.5 })).status === 400);
  check("penalty row saved", (await call("/api/mail/tracker/penalty", admin, "POST", { atmId: A, days: 3, penalty: "1,500", month })).status === 200);
  const pv = await call("/api/mail/tracker/pvc", admin, "POST", { atmId: A, pvcDate: "2025-01-01", expiry: "2025-12-31", month, file: { fileName: "pvc.pdf", mime: "application/pdf", data: b64("pvc") } });
  check("PVC expiry before PVC date refused", (await call("/api/mail/tracker-row/" + pv.data.id, admin, "PATCH", { expiry: "2024-01-01" })).status === 400);
  const pvRow = (await trk("pvc")).data.rows.find((r) => r._id === pv.data.id);
  check("PVC past expiry shows Expired with file", pvRow && pvRow.status === "Expired" && pvRow.files.length === 1);
  await call("/api/mail/tracker-row/" + pv.data.id, admin, "PATCH", { expiry: ist(10) });
  check("PVC expiring within 30 days shows Renewal Due", (await trk("pvc")).data.rows.find((r) => r._id === pv.data.id).status === "Renewal Due");
  check("franchisee sees own tracker rows", (await trk("penalty", fran)).data.rows.some((r) => r.atmId === A));
  check("franchisee cannot add tracker rows", (await call("/api/mail/tracker/penalty", fran, "POST", { atmId: A, days: 1 })).status === 403);
  check("company B sees none of them", !(await trk("penalty", adminB)).data.rows.some((r) => r.atmId === A));
  check("field staff cannot open trackers", (await trk("penalty", so)).status === 403);
  const tcsv = (await trk("penalty", admin, "&csv=1")).data;
  check("tracker CSV export with BOM", tcsv.csv.startsWith("\uFEFF") && tcsv.csv.includes(A));
  const mailEvents = await Promise.all(["MailSent", "MailFailed", "ReplyMapped", "MailboxConnected", "MailTemplateSaved"].map((e) => aud("event=" + e, admin)));
  check("mail audit trail written", mailEvents.every((r) => r.data.events.length > 0));

  // Rescan 5: mail, trackers, documents
  check("franchisee cannot list drafts by status", (await call("/api/mail?status=Draft", fran)).data.rows.length === 0 && (await call("/api/mail?complaintId=" + mtId + "&status=Draft", fran)).data.rows.length === 0);
  check("franchisee mail list shows ticket threads only", (await call("/api/mail", fran)).data.rows.every((m) => !!m.complaintId));
  const dupIn = { from: "fr@demo.local", messageId: "<race." + stamp + "@fr>", subject: "About " + mtDocket, body: "" };
  const [race1, race2] = await Promise.all([call("/api/mail/inbound", admin, "POST", dupIn), call("/api/mail/inbound", admin, "POST", dupIn)]);
  check("same inbound message sent twice at once is stored once", [race1.status, race2.status].sort().join() === "200,409");
  check("tracker file over 5 MB refused", (await call("/api/mail/tracker/penalty", admin, "POST", { atmId: A, days: 1, file: { fileName: "big.bin", data: Buffer.alloc(5 * 1024 * 1024 + 10).toString("base64") } })).status === 400);
  check("Sales Officer cannot open a mail attachment", (await call("/api/documents/" + drFile._id + "/file", so)).status === 404);
  const soDocs = await call("/api/documents?parentType=mail", so);
  check("Sales Officer document list hides mail files", soDocs.status === 403 || !soDocs.data.documents.length);
  await call("/api/auth/company", dexter, "POST", { companyId: meB.companyId });
  check("Dexter switched to company B cannot touch company A mail", (await call("/api/mail?complaintId=" + mtId, dexter)).status === 404 && (await call("/api/mail/" + sent.data.id, dexter, "PATCH", { action: "retry" })).status === 404);
  await call("/api/auth/company", dexter, "POST", { companyId: dexHome.homeCompanyId });

  // Phase 3 slice 5: installable mobile web
  const web = (p, accept) => fetch(B + p, { headers: { Accept: accept || "*/*" } });
  const man = await web("/manifest.webmanifest");
  const manJson = await man.json().catch(() => ({}));
  check("manifest served for install", man.status === 200 && /manifest\+json/.test(man.headers.get("content-type")) && manJson.display === "standalone" && manJson.start_url === "/");
  check("manifest has 192 and 512 icons", ["192x192", "512x512"].every((s) => (manJson.icons || []).some((i) => i.sizes === s)));
  check("icons served", (await web("/icon-192.png")).status === 200 && (await web("/icon-512.png")).status === 200);
  const swr = await web("/sw.js");
  const swText = await swr.text();
  check("service worker served uncached", swr.status === 200 && swr.headers.get("cache-control") === "no-cache");
  check("service worker never caches API data", swText.includes('startsWith("/api/")') && !/cache[^\n]*\/api\//i.test(swText.replace('url.pathname.startsWith("/api/")', "")));
  const deep = await web("/service/anything", "text/html");
  check("app opens on any page URL (installed start)", deep.status === 200 && (await deep.text()).includes('rel="manifest"'));
  const apiMiss = await call("/api/nope-" + stamp, admin);
  check("unknown API path is JSON 404, not the app", apiMiss.status === 404 && apiMiss.data.error === "not found");
  const hdr = await fetch(B + "/api/auth/me", { headers: { Authorization: "Bearer " + fran } });
  check("API responses are not stored by the phone", hdr.headers.get("cache-control") === "no-store");
  check("app cannot be framed; no MIME sniffing", hdr.headers.get("x-frame-options") === "DENY" && hdr.headers.get("x-content-type-options") === "nosniff");
  check("camera and location allowed for this site only", /camera=\(self\)/.test(hdr.headers.get("permissions-policy") || "") && /geolocation=\(self\)/.test(hdr.headers.get("permissions-policy") || ""));
  const soPages = (await call("/api/auth/me", so)).data.user;
  check("same RBAC on phone: Sales Officer is field staff", soPages.fieldStaff === true && (await call("/api/audit", so)).status === 403 && (await call("/api/mail/tracker/penalty", so)).status === 403);

  // Gap build: imports, finance, complaints, tasks, custom columns, Apna statements
  const eodCsv = "atmId,date,eodTime,opening,dispenseMachine,dispenseApna,physical500,remarks\n" + A + "," + today + ",23:00,160000,10000,10000,300,imported\n" + A + ",2026-09-28,23:00,1,1,1,1,locked day\nNOPE" + stamp + "," + today + ",23:00,0,0,0,0,x";
  check("franchisee cannot import EOD", (await call("/api/imports", fran, "POST", { template: "EOD", csv: eodCsv })).status === 403);
  const eodImp = await call("/api/imports", admin, "POST", { template: "EOD", csv: eodCsv });
  check("EOD import: good row in, locked day and unknown ATM rejected", eodImp.status === 200 && eodImp.data.batch.accepted === 1 && eodImp.data.batch.rejected === 2);
  const eodIn = (await call("/api/ops/eod?date=" + today, admin)).data.rows.find((r) => r.atmId === A);
  check("imported EOD saved with flat deno columns", eodIn && eodIn.source === "import" && eodIn.physicalTotal === 150000 && eodIn.status === "Draft");
  check("EOD import refuses a bad EOD time", (await call("/api/imports", admin, "POST", { template: "EOD", csv: "atmId,date,eodTime\n" + A + "," + today + ",25:99" })).data.batch.accepted === 0);
  const ldCsv = "atmId,date,withdrawal,withdrawal500,loading500\n" + A + "," + ist(-2) + ",1000,2,2\n" + A + "," + ist(-2) + ",1000,1,1";
  const ldImp = await call("/api/imports", admin, "POST", { template: "daily-loading", csv: ldCsv });
  check("daily loading import: deno total must match withdrawal", ldImp.status === 200 && ldImp.data.batch.accepted === 1 && ldImp.data.batch.rejected === 1);
  check("franchisee cannot import daily loading file", (await call("/api/imports", fran, "POST", { template: "daily-loading", csv: ldCsv })).status === 403);
  const gstCsv = "franchise,month,gstin,grossAmount,remark\n" + othName + ",2025-01,27ABCDE1234F1Z5,10000,imported\n" + othName + ",2025-02,BADGSTIN,10000,x";
  check("franchisee cannot import GST list", (await call("/api/imports", fran, "POST", { template: "GST-list", csv: gstCsv })).status === 403);
  const gstImp = await call("/api/imports", fin, "POST", { template: "GST-list", csv: gstCsv });
  check("GST list import: bad GSTIN row rejected, good row billed", gstImp.status === 200 && gstImp.data.batch.accepted === 1 && gstImp.data.batch.rejected === 1);
  check("imported GST bill listed with 18% GST", (await call("/api/finance/gst-bills", fin)).data.rows.some((r) => r.month === "2025-01" && String(r.franchiseId) === oth && r.gstAmount === 1800 && r.billNo));
  check("ICD funding saved as its own path", (await call("/api/ops/funding", admin, "PUT", { type: "ICD", atmId: A, date: today, lastDayDispenseApna: 0, axisLot1: 1000, axisLot2: 0, loadingCbr: 1000 })).status === 200);
  check("ICD row has zero difference", (await call("/api/ops/funding?date=" + today, admin)).data.rows.some((r) => r.atmId === A && r.type === "ICD" && r.loadingDiff === 0));
  check("unknown funding type refused", (await call("/api/ops/funding", admin, "PUT", { type: "XYZ", atmId: A, date: today })).status === 400);
  check("CBR 3 ICD import", (await call("/api/imports", admin, "POST", { template: "CBR-3-ICD", csv: "date,atmId,axisLot1,axisLot2,loadingCbr\n" + ist(-2) + "," + A + ",500,0,500" })).data.batch.accepted === 1);
  check("CBR 3 Axis & ICD report shows the ICD path", (await call("/api/reports/view/cbr3-axis?month=" + today.slice(0, 7), admin)).data.rows.some((r) => r.atmId === A && r.type === "ICD"));

  const settle = (tok, body) => call("/api/finance/security-deposits/" + sd.data.id + "/settle", tok, "POST", body);
  check("franchisee cannot refund a deposit", (await settle(fran, { action: "refund", amount: 1, reason: "x", utr: "U" })).status === 403);
  check("refund needs a UTR", (await settle(fin, { action: "refund", amount: 30000, reason: "exit" })).status === 400);
  check("Finance refunds part of the deposit", (await settle(fin, { action: "refund", amount: 30000, reason: "partial exit", utr: "RF" + stamp })).status === 200);
  check("cannot adjust more than is held", (await settle(fin, { action: "adjust", amount: 80000, reason: "x", against: "Charge-back" })).status === 400);
  check("adjust needs a known reason type", (await settle(fin, { action: "adjust", amount: 1000, reason: "x", against: "Party" })).status === 400);
  check("Finance adjusts against charge-back", (await settle(fin, { action: "adjust", amount: 20000, reason: "CB RRN", against: "Charge-back" })).status === 200);
  const sdRow3 = (await call("/api/finance/security-deposits", admin)).data.rows.find((r) => r._id === sd.data.id);
  check("deposit shows refunded, adjusted and held", sdRow3.refunded === 30000 && sdRow3.adjusted === 20000 && sdRow3.held === 50000 && sdRow3.status === "Partly Refunded/Adjusted" && sdRow3.movements.length === 2);
  check("refund and adjustment audited", (await aud("event=SecurityDepositRefunded")).data.events.length > 0 && (await aud("event=SecurityDepositAdjusted")).data.events.length > 0);

  check("Sub Admin cannot change complaint settings", (await call("/api/service/settings", sub, "PATCH", { verifyBeforeClose: true })).status === 403);
  check("bad region key refused", (await call("/api/service/settings", admin, "PATCH", { serviceMap: { "a.b": { ssm: "x" } } })).status === 400);
  check("Admin sets SSM / RM mapping and verify-before-close", (await call("/api/service/settings", admin, "PATCH", { serviceMap: { "*": { ssm: "SSM One", rm: "RM One" } }, verifyBeforeClose: true })).status === 200);
  const vt = await call("/api/complaints", admin, "POST", { atmId: A, problemType: "Power / UPS", subject: "ups " + stamp });
  const vtRow = () => call("/api/complaints/" + vt.data.id, admin).then((r) => r.data.complaint);
  check("new ticket gets SSM / RM from the mapping", vt.status === 200 && (await vtRow()).ssm === "SSM One" && (await vtRow()).rm === "RM One");
  await call("/api/complaints/" + vt.data.id, admin, "PATCH", { action: "assign", ownerUserId: subId });
  const vtTask = () => call("/api/tasks?view=all", admin).then((r) => r.data.rows.find((t) => t.complaintId === vt.data.id && t.source === "Ticket"));
  check("ticket owner gets a linked task", !!(await vtTask()) && String((await vtTask()).assigneeId) === subId);
  await call("/api/complaints/" + vt.data.id, admin, "PATCH", { action: "status", status: "Resolved", resolution: "UPS reset" });
  check("close refused until the resolution is verified", (await call("/api/complaints/" + vt.data.id, admin, "PATCH", { action: "status", status: "Closed", closureRemarks: "ok" })).status === 400);
  check("resolver cannot verify own resolution", (await call("/api/complaints/" + vt.data.id, admin, "PATCH", { action: "verify", remark: "ok" })).status === 403);
  check("another desk user verifies", (await call("/api/complaints/" + vt.data.id, sub, "PATCH", { action: "verify", remark: "confirmed with FR" })).status === 200);
  check("verified ticket closes", (await call("/api/complaints/" + vt.data.id, admin, "PATCH", { action: "status", status: "Closed", closureRemarks: "ok" })).status === 200);
  check("closing the ticket closes its task", !(await vtTask()) || (await vtTask()).status === "Closed");
  await call("/api/service/settings", admin, "PATCH", { serviceMap: {}, verifyBeforeClose: false, autoEscalateHours: { SSM: 0 } });
  await call("/api/service/sla", admin, "PATCH", { Critical: 0.0005 });
  const ae = await call("/api/complaints", admin, "POST", { atmId: A, problemType: "Network / VSAT", subject: "vsat " + stamp, priority: "Critical" });
  await call("/api/service/sla", admin, "PATCH", { Critical: 4 });
  await sleep(2500);
  await sweep(admin);
  const aeRow = (await call("/api/complaints/" + ae.data.id, admin)).data.complaint;
  check("overdue ticket auto-escalated to SSM by the sweep", aeRow.escalationLevel >= 1 && aeRow.status === "Escalated" && aeRow.history.some((h) => /^auto:/.test(h.remark || "")));
  check("auto-escalation audited", (await aud("event=AutoEscalated")).data.events.length > 0);

  const tk = await call("/api/tasks", admin, "POST", { title: "Files " + stamp, assigneeId: subId });
  check("task file attached", (await call("/api/tasks/" + tk.data.id + "/files", admin, "POST", { type: "Quote", fileName: "q.pdf", data: b64("quote") })).status === 200);
  check("task shows its file", (await call("/api/tasks/" + tk.data.id, sub)).data.files.some((d) => d.type === "Quote"));
  check("task file type allowlist", (await call("/api/tasks/" + tk.data.id + "/files", admin, "POST", { fileName: "x.exe", data: b64("x") })).status === 400);
  check("outsider cannot attach to the task", (await call("/api/tasks/" + tk.data.id + "/files", fran, "POST", { fileName: "q.pdf", data: b64("x") })).status === 404);
  check("task files only through the Tasks page", (await call("/api/documents", admin, "POST", { parentType: "task", parentId: tk.data.id, type: "x", fileName: "q.pdf", data: b64("x") })).status === 400);
  check("project stages create project tasks", (await call("/api/tasks?view=all&projectId=" + proj.data.id, admin)).data.rows.some((t) => t.source === "Project" && t.projectId === proj.data.id));

  const colName = "Survey " + stamp;
  check("custom column on another register", (await call("/api/register-columns", admin, "POST", { register: "site", name: colName, type: "number" })).status === 200);
  check("unknown register refused", (await call("/api/register-columns", admin, "POST", { register: "nope", name: "x" })).status === 400);
  check("unknown column type refused", (await call("/api/register-columns", admin, "POST", { register: "site", name: "y" + stamp, type: "blob" })).status === 400);
  check("duplicate column refused", (await call("/api/register-columns", admin, "POST", { register: "site", name: colName, type: "text" })).status === 409);
  const newSite = await call("/api/sites", admin, "POST", { siteId: "SITE-" + stamp, city: "Indore", region: "Central", district: "Indore" });
  check("site saved with region and district", newSite.status === 200);
  const aSite = (await call("/api/sites", admin)).data.sites.find((s) => s.siteId === "SITE-" + stamp);
  check("site edit screen saves", (await call("/api/sites/" + aSite._id, admin, "PATCH", { landmark: "Near bus stand" })).status === 200 && (await call("/api/sites", admin)).data.sites.find((s) => s._id === aSite._id).landmark === "Near bus stand");
  const setX = (tok, extra) => call("/api/registers/site/" + aSite._id + "/extra", tok, "PATCH", { extra });
  check("number column refuses text", (await setX(admin, { [colName]: "abc" })).status === 400);
  check("number column saved as a number", (await setX(admin, { [colName]: "12" })).status === 200 && (await call("/api/sites", admin)).data.sites.find((s) => s._id === aSite._id).extra[colName] === 12);
  check("unknown column name refused", (await setX(admin, { ["Nope" + stamp]: "1" })).status === 400);
  check("franchisee cannot fill custom columns", (await setX(fran, { [colName]: "1" })).status === 403);
  const reqCol = await call("/api/register-columns", admin, "POST", { register: "site", name: "Req " + stamp, type: "text", required: true });
  check("required column must be filled on edit", (await setX(admin, { [colName]: "13" })).status === 400);
  const siteCols = (await call("/api/register-columns?register=site", admin)).data.columns.filter((c) => c.name === colName || c._id === reqCol.data.id);
  for (const c of siteCols) await call("/api/register-columns/" + c._id, admin, "DELETE");

  const apm = await call("/api/apna", admin, "POST", { atmId: A, location: "Smoke", franchiseId: frId });
  const stmt = await call("/api/documents", fran, "POST", { parentType: "apna", parentId: apm.data.id, type: "Apna statement 2026-09", fileName: "apna.pdf", data: b64("stmt") });
  check("franchisee uploads own Apna statement", stmt.status === 200);
  check("franchisee sees the statement", (await call("/api/documents?parentType=apna", fran)).data.documents.some((d) => d._id === stmt.data.id));
  check("company B cannot see the statement", (await call("/api/documents/" + stmt.data.id + "/file", adminB)).status === 404);
  check("FFM report has a month-end check column", (await call("/api/reports/view/ffm-eod?month=" + today.slice(0, 7), admin)).data.columns.some((c) => c.key === "monthEndCheck"));
  check("stage reminder interval validated", (await call("/api/lookups", admin, "PATCH", { stageReminderDays: 0 })).status === 400 && (await call("/api/lookups", admin, "PATCH", { stageReminderDays: 3 })).status === 200);
  check("franchise signature field saved", (await call("/api/applications/" + fa.data.id, fran, "PATCH", { signedByName: "R Kumar" })).status === 200 && (await call("/api/applications", fran)).data.applications.find((x) => x._id === fa.data.id).signedByName === "R Kumar");

  // Phase 4, slice 1: permission fixes
  {
  const verifier = await login("verifier@demo.local", "Verify@123");
  const exec = await login("executive@demo.local", "Exec@1234");
  const ops4 = await login("ops@demo.local", "Ops@12345");
  const mon = today.slice(0, 7);
  check("franchisee cannot export a Dexter-3 report", (await call("/api/reports/view/dlr3?csv=1&month=" + mon, fran)).status === 403);
  check("franchisee still views own report", (await call("/api/reports/view/dlr3?month=" + mon, fran)).status === 200);
  check("Admin exports a Dexter-3 report", (await call("/api/reports/view/dlr3?csv=1&month=" + mon, admin)).status === 200);
  check("report meta tells the UI who may export", (await call("/api/reports/meta", fran)).data.canExport === false && (await call("/api/reports/meta", admin)).data.canExport === true);
  check("franchise user cannot list users", (await call("/api/users", fran)).status === 403);
  check("franchise user cannot list employees", (await call("/api/employees", fran)).status === 403);
  check("Sub Admin cannot create a project", (await call("/api/projects", sub, "POST", { name: "x" + stamp })).status === 403);
  check("user create refuses another company's project", (await call("/api/users", admin, "POST", { login: "px" + stamp + "@x", password: "Passw0rd1", name: "p", hierarchy: "SubAdmin", projectIds: ["000000000000000000000001"] })).status === 400);
  const masterNode = frs.find((f) => f.layer === "MasterFranchise");
  check("franchise user node must match the layer", (await call("/api/users", admin, "POST", { login: "lx" + stamp + "@x", password: "Passw0rd1", name: "l", hierarchy: "Franchise", franchiseId: masterNode._id })).status === 400);
  const emp4 = await call("/api/employees", admin, "POST", { name: "Emp " + stamp, region: "Central", team: "North", employmentStatus: "Active" });
  check("employee create keeps region and team", emp4.status === 200 && (await call("/api/employees", admin)).data.employees.some((e) => e._id === emp4.data.id && e.region === "Central" && e.team === "North"));
  check("employee status validated on create", (await call("/api/employees", admin, "POST", { name: "E2", employmentStatus: "Gone" })).status === 400);
  const loi4 = await call("/api/lois", admin, "POST", { loiCode: "L4-" + stamp, franchiseId: frId });
  check("LOI status must be a known value", (await call("/api/lois/" + loi4.data.id, admin, "PATCH", { status: "Whatever" })).status === 400);
  check("LOI Uploaded needs a file", (await call("/api/lois/" + loi4.data.id, admin, "PATCH", { status: "Uploaded" })).status === 400);
  check("Verifier approves LOI", (await call("/api/lois/" + loi4.data.id, verifier, "PATCH", { approve: true })).status === 200);
  check("Verifier cannot re-decide an approved LOI", (await call("/api/lois/" + loi4.data.id, verifier, "PATCH", { reject: true })).status === 400);
  check("Admin override needs a reason", (await call("/api/lois/" + loi4.data.id, admin, "PATCH", { reject: true })).status === 400);
  check("Admin overrides with a reason", (await call("/api/lois/" + loi4.data.id, admin, "PATCH", { reject: true, reason: "wrong site" })).status === 200);
  check("LOI audit keeps the old status", (await aud("event=LOIUpdated")).data.events.some((e) => e.before && e.before.status === "Approved"));
  const agr4 = await call("/api/agreements", admin, "POST", { franchiseId: frId });
  check("agreement link must be a web address", (await call("/api/agreements/" + agr4.data.id, admin, "PATCH", { link: "not a link" })).status === 400);
  check("agreement Link Shared with link and type", (await call("/api/agreements/" + agr4.data.id, admin, "PATCH", { status: "Link Shared", link: "https://sign.example/abc", agreementType: "WLA Franchise" })).status === 200);
  check("agreement type must come from the lookup", (await call("/api/agreements/" + agr4.data.id, admin, "PATCH", { agreementType: "Nope" })).status === 400);
  check("franchise notified when the link is shared", (await call("/api/notices", fran)).data.rows.some((n) => n.kind === "legal"));
  check("Executive without Export cannot download others' KYC", (await call("/api/documents/" + d2.data.id + "/file", exec)).status === 403);
  check("Verifier downloads KYC to verify", (await call("/api/documents/" + d2.data.id + "/file", verifier)).status === 200);
  const exDay = ist(-12);
  await call("/api/ops/txn", ops4, "PUT", { atmId: "DEMO0001", date: ist(-13), cashCount: 5 });
  const e1 = await call("/api/ops/txn", exec, "PUT", { atmId: "DEMO0001", date: exDay, cashCount: 7 });
  check("Executive enters TXN", e1.status === 200);
  const exec2 = await call("/api/users", admin, "POST", { login: "exec2-" + stamp + "@demo.local", password: "Exec2pass1", name: "Exec Two", hierarchy: "SubAdmin", functionalRole: "Executive", actions: ["View", "Create", "Edit"], modules: ["CRM-04"] });
  await call("/api/users/" + exec2.data.id + "/activate", admin, "PATCH");
  const execB = await login("exec2-" + stamp + "@demo.local", "Exec2pass1");
  check("another Executive cannot overwrite the row", (await call("/api/ops/txn", execB, "PUT", { atmId: "DEMO0001", date: exDay, cashCount: 9 })).status === 400);
  check("Admin can still change it", (await call("/api/ops/txn", admin, "PUT", { atmId: "DEMO0001", date: exDay, cashCount: 9 })).status === 200);
  check("importer needs Create on the module", (await call("/api/imports", execB, "POST", { template: "inspection-list", csv: "atmId,date\nX,2026-01-01" })).status === 403);
  }

  // Phase 4, slice 2: sheet columns
  {
  const pdf2 = { fileName: "p.pdf", mime: "application/pdf", data: b64("proof") };
  const grid = await call("/api/applications/" + fa.data.id, fran, "PATCH", {
    nearestAtms: { A: { atmId: "N1", bank: "SBI", siteType: "Onsite", distance: "200m" }, B: "LEGACY9" },
    nearbyHitachi: { A: { atmId: "H1" } },
    docChecklist: { PAN: true, GST: "Yes" },
    lShapeSignage: "Yes",
    frontageOffered: "12 ft",
  });
  const faRow = (await call("/api/applications", fran)).data.applications.find((x) => x._id === fa.data.id);
  check("application keeps the nearest-ATM grid", grid.status === 200 && faRow.nearestAtms.A.bank === "SBI" && faRow.nearestAtms.B.atmId === "LEGACY9" && faRow.nearbyHitachi.A.atmId === "H1");
  check("application doc checklist is Yes / No", faRow.docChecklist.PAN === "Yes" && faRow.docChecklist.GST === "Yes" && faRow.docChecklist.Aadhaar === "No");
  check("application signage and frontage saved", faRow.lShapeSignage === "Yes" && faRow.frontageOffered === "12 ft");
  const demoAtm = (await call("/api/atms", admin)).data.atms.find((a) => a.atmId === "DEMO0001");
  check("ATM funding path validated", (await call("/api/atms/" + demoAtm._id, admin, "PATCH", { fundingPath: "Nope" })).status === 400);
  check("ATM MD type and second email saved", (await call("/api/atms/" + demoAtm._id, admin, "PATCH", { mdType: "FFM", email2: "b@x.in", fundingPath: "Axis" })).status === 200);
  check("franchise status comes from the fixed list", (await call("/api/franchises/" + frId, admin, "PATCH", { status: "Gone" })).status === 400);
  check("franchise GSTIN validated", (await call("/api/franchises/" + frId, admin, "PATCH", { gstin: "BAD" })).status === 400);
  check("franchise master fields saved", (await call("/api/franchises/" + frId, admin, "PATCH", { gstin: "23ABCDE1234F1Z5", ownerName: "R Kumar", ownershipType: "Proprietor", mobile: "9876543210" })).status === 200);
  const frRow = (await call("/api/franchises", admin)).data.franchises.find((f) => f._id === frId);
  check("franchise list shows master fields and KYC status", frRow.gstin === "23ABCDE1234F1Z5" && frRow.ownerName === "R Kumar" && typeof frRow.kycStatus === "string");
  const kycRow = (await call("/api/documents?parentType=application", admin)).data.documents.find((d) => d.uploadedBy);
  check("KYC list names the uploader", !!kycRow && typeof kycRow.uploadedByName === "string" && kycRow.uploadedByName.length > 0);
  const clf = await call("/api/finance/payments", fin, "POST", { kind: "CLF", atmId: A, installment: 11, amount: 100 });
  check("CLF installment must be 1 to 10", clf.status === 400 && /installment/.test(clf.data.error));
  const bsBad = await call("/api/finance/bank-statements", fin, "POST", { franchiseId: frId, month: "2026-07", accountType: "Bogus", file: pdf2 });
  check("bank statement account type validated", bsBad.status === 400 && /account type/.test(bsBad.data.error));
  check("bank statement keeps ATM and account type", (await call("/api/finance/bank-statements", fin, "POST", { franchiseId: frId, month: "2026-07", atmId: "DEMO0001", accountType: "Current", hitachiCode: "HC1", file: pdf2 })).status === 200);
  const bs7 = (await call("/api/finance/bank-statements?fy=2026-27", fin)).data.rows.find((r) => r.month === "2026-07" && String(r.franchiseId) === frId);
  check("bank statement row shows ATM / Hitachi code / type", bs7 && bs7.atmId === "DEMO0001" && bs7.hitachiCode === "HC1" && bs7.accountType === "Current");
  for (const kind of ["security-deposits", "bank-statements", "chargebacks"]) check("finance export " + kind, (await call("/api/finance/export?kind=" + kind, admin)).status === 200);
  let tk = await call("/api/complaints", admin, "POST", { atmId: "DEMO0001", problemType: "Display", subject: "display " + stamp });
  const tkId = tk.data.id || ((await call("/api/complaints?view=open", admin)).data.complaints.find((c) => c.atmId === "DEMO0001" && c.problemType === "Display") || {})._id;
  check("complaint team must come from the lookup", (await call("/api/complaints/" + tkId, admin, "PATCH", { action: "details", team: "Nowhere" })).status === 400);
  check("complaint details saved (FLM, team, category, outcome)", (await call("/api/complaints/" + tkId, admin, "PATCH", { action: "details", team: "Service Desk", flmDone: true, category: "Print", outcome: "Part replaced" })).status === 200);
  const tkRow = (await call("/api/complaints/" + tkId, admin)).data.complaint;
  check("complaint shows FLM done, team, category, outcome", tkRow.flmDone === true && tkRow.team === "Service Desk" && tkRow.category === "Print" && tkRow.outcome === "Part replaced");
  const soon = new Date(Date.now() + 3600 * 1000).toISOString();
  const tsk = await call("/api/tasks", admin, "POST", { title: "Remind " + stamp, startAt: new Date().toISOString(), dueAt: new Date(Date.now() + 86400000).toISOString(), reminderAt: soon, complaintId: tkId });
  check("task create keeps start, ticket and reminder", tsk.status === 200 && (await call("/api/tasks/" + tsk.data.id, admin)).data.task.reminders.length === 1);
  check("task reminder must be in the future", (await call("/api/tasks/" + tsk.data.id, admin, "PATCH", { action: "remind", at: "2020-01-01T00:00:00Z" })).status === 400);
  check("task reminder added", (await call("/api/tasks/" + tsk.data.id, admin, "PATCH", { action: "remind", at: soon, text: "call back" })).status === 200);
  const cbDay = ist(-15);
  check("CBR-1 AQS row saved", (await call("/api/ops/cbr1", admin, "PUT", { atmId: "DEMO0001", date: cbDay, deno: "AQS", openingAmount: 1000 })).status === 200);
  check("CBR-1 switch counter per deno", (await call("/api/ops/cbr1", admin, "PUT", { atmId: "DEMO0001", date: cbDay, deno: 500, switchNotes: 2 })).status === 200);
  const cbRow = (await call("/api/ops/cbr1?date=" + cbDay, admin)).data.rows.find((r) => r.atmId === "DEMO0001");
  check("CBR-1 row has Sr. No., AQS and switch totals", cbRow && cbRow.srNo >= 1 && cbRow.side.AQS.openingAmount === 1000 && cbRow.totals.switch === 1000);
  const atmCsv = "atmId,atmSerialNumber,machineTypeModel,mdType,fundingPath,email2\nIMP" + stamp + ",S1,NCR,SF,WLA,x@y.in\nIMPX" + stamp + ",S2,NCR,SF,Nope,";
  const atmImp = await call("/api/imports", admin, "POST", { template: "ATM-master", csv: atmCsv });
  check("ATM master import takes the new columns", atmImp.status === 200 && atmImp.data.batch.accepted === 1 && atmImp.data.batch.rejected === 1);
  check("imported ATM has MD type", (await call("/api/atms", admin)).data.atms.some((a) => a.atmId === "IMP" + stamp && a.mdType === "SF" && a.fundingPath === "WLA"));
  check("agreement types editable in lookups", (await call("/api/lookups", admin, "PATCH", { agreementTypes: ["WLA Franchise", "Addendum", "Renewal"] })).status === 200);
  }

  // Phase 4, slice 3: workflow
  {
  const verifier = await login("verifier@demo.local", "Verify@123");
  const exec = await login("executive@demo.local", "Exec@1234");
  const ops4 = await login("ops@demo.local", "Ops@12345");
  const A = "DEMO0001";
  const d3 = ist(-20);
  check("TXN saved inside the entry window", (await call("/api/ops/txn", admin, "PUT", { atmId: A, date: d3, cashCount: 4, cashAmount: 2000 })).status === 200);
  await call("/api/lookups", admin, "PATCH", { txnEntryDays: 5 });
  const old = await call("/api/ops/txn", ops4, "PUT", { atmId: A, date: ist(-10), cashCount: 1, cashAmount: 100 });
  await call("/api/lookups", admin, "PATCH", { txnEntryDays: 45 });
  check("TXN older than the entry window refused for non-Admin", old.status === 400 && /entry window/.test(old.data.error));
  check("non-Verifier cannot confirm TXN", (await call("/api/ops/txn/confirm", exec, "POST", { date: d3 })).status === 403);
  const conf = await call("/api/ops/txn/confirm", verifier, "POST", { date: d3, atmId: A });
  check("Verifier confirms the day", conf.status === 200 || /nothing to confirm/.test(conf.data.error || ""));
  check("confirmed TXN row marked", (await call("/api/ops/txn?month=" + d3.slice(0, 7), admin)).data.rows.some((r) => r.atmId === A && r.date === d3 && r.confirmedAt));
  const locked = await call("/api/ops/txn", ops4, "PUT", { atmId: A, date: d3, cashCount: 9, cashAmount: 9000 });
  check("confirmed TXN locked for non-Admin", locked.status === 400 && /confirmed/.test(locked.data.error));
  check("Admin corrects confirmed TXN", (await call("/api/ops/txn", admin, "PUT", { atmId: A, date: d3, cashCount: 5, cashAmount: 2500 })).status === 200);
  const txe = await call("/api/ops/txn/export?month=" + d3.slice(0, 7), admin);
  check("TXN export CSV", txe.status === 200 && txe.data.csv.includes("confirmed") && txe.data.csv.includes(A));
  check("franchisee cannot export TXN", (await call("/api/ops/txn/export", fran)).status === 403);

  const g1 = ist(-5), g2 = ist(-6);
  const gridCsv = "atmId,metric," + g1 + "," + g2 + "\n" + A + ",upiCount,7,8\n" + A + ",upiAmount,700,800";
  const pv = await call("/api/imports", admin, "POST", { template: "TXN-grid", fileName: "grid.csv", csv: gridCsv, preview: true });
  check("import preview shows rows without saving", pv.status === 200 && pv.data.preview.totalRows === 4 && pv.data.preview.sample.length === 4 && !pv.data.batch);
  const gi = await call("/api/imports", admin, "POST", { template: "TXN-grid", fileName: "grid.csv", csv: gridCsv });
  check("TXN grid import accepted", gi.status === 200 && gi.data.batch.accepted === 4 && gi.data.batch.rejected === 0);
  const gRow = (await call("/api/ops/txn?month=" + g1.slice(0, 7), admin)).data.rows.find((r) => r.atmId === A && r.date === g1);
  check("grid values landed on the day row", gRow && gRow.upiCount === 7 && gRow.upiAmount === 700);
  const { writeXlsx } = require("../src/utils/xlsx");
  const xbuf = writeXlsx([["atmId", "date", "cashCount", "cashAmount"], [A, ist(-7), 3, 1500]]);
  const xi = await call("/api/imports", admin, "POST", { template: "TXN-daily", fileName: "txn.xlsx", xlsx: xbuf.toString("base64") });
  check("xlsx import accepted", xi.status === 200 && xi.data.batch.accepted === 1);
  const batchId = xi.data.batch && (xi.data.batch._id || xi.data.batch.id);
  const orig = batchId ? await call("/api/imports/" + batchId + "/original", admin) : { status: 0, data: {} };
  check("original xlsx file downloadable", orig.status === 200 && /sheet/.test(orig.data.mime) && orig.data.data.length > 50);

  const cplx = await call("/api/complaints-export", admin);
  check("complaint register export", cplx.status === 200 && cplx.data.csv.includes("forwardedOn") && cplx.data.csv.includes("flmDone"));
  check("franchisee cannot export complaint register", (await call("/api/complaints-export", fran)).status === 403);

  const MT = "MT" + stamp;
  await call("/api/atms", admin, "POST", { atmId: MT, atmSerialNumber: "SN-MT", machineTypeModel: "NCR", franchiseId: frId });
  const im = await call("/api/mail/inbound", admin, "POST", { from: "cust" + stamp + "@x.in", messageId: "<tk." + stamp + "@x>", subject: "machine down " + stamp, body: "please fix" });
  const tfm = await call("/api/mail/" + im.data.id + "/ticket", admin, "POST", { atmId: MT, problemType: "Power / UPS" });
  check("ticket raised from inbound mail", tfm.status === 200 && /./.test(tfm.data.docketNumber || ""));
  check("mail cannot raise a second ticket", (await call("/api/mail/" + im.data.id + "/ticket", admin, "POST", { atmId: MT, problemType: "Display" })).status === 400);
  check("franchisee cannot raise ticket from mail", (await call("/api/mail/" + im.data.id + "/ticket", fran, "POST", {})).status === 403);
  if (tfm.data.id) {
    const tc = (await call("/api/complaints/" + tfm.data.id, admin)).data.complaint;
    check("mail ticket has channel Mail and an ack mail queued", tc.channel === "Mail" && !!tc.ackMailId);
  }

  const execId = await findUser(admin, "executive@demo.local");
  const franId = await findUser(admin, "franchisee@demo.local");
  const st = await call("/api/tasks", admin, "POST", { title: "Share " + stamp, dueAt: new Date(Date.now() + 86400000).toISOString() });
  check("task cannot be shared with a franchise user", (await call("/api/tasks/" + st.data.id, admin, "PATCH", { action: "share", userIds: [franId] })).status === 400);
  check("task shared with an office user", (await call("/api/tasks/" + st.data.id, admin, "PATCH", { action: "share", userIds: [execId] })).status === 200);
  check("shared task appears in the shared view", (await call("/api/tasks?view=shared", exec)).data.rows.some((t) => t._id === st.data.id));

  const cb2 = await call("/api/finance/chargebacks", fin, "POST", { ...cbBody, tlfRrn: "RRN2" + stamp, disputeAmount: 1200 });
  await call("/api/finance/chargebacks/" + cb2.data.id, fin, "PATCH", { status: "Accepted" });
  const pNov = await call("/api/imports", fin, "POST", { template: "payout", csv: "franchise,month,amount\n" + othName + ",2026-11,5000" });
  const poNov = (await call("/api/finance/payouts", admin)).data.rows.find((r) => r.franchiseName === othName && r.month === "2026-11");
  check("payout import deducts accepted charge-backs", pNov.data.batch.accepted === 1 && poNov && poNov.chargeBackDeduction === 1200 && poNov.netAmount === 3800);
  check("deducted charge-back marked as billed in the payout", (await call("/api/finance/chargebacks", admin)).data.rows.find((r) => r._id === cb2.data.id).billedIn === poNov._id);

  check("manual calling row without a ticket", (await call("/api/mail/tracker/calling", admin, "POST", { atmId: A, callDate: ist(0), calledBy: "desk", remarks: "manual " + stamp, month })).status === 200);
  const calling = (await trk("calling")).data;
  check("calling tracker merges manual rows", calling.manual && calling.rows.some((r) => String(r.remarks).includes("manual " + stamp)));

  check("denominations limited to the fixed list", (await call("/api/lookups", admin, "PATCH", { denos: [100, 300] })).status === 400);
  check("stage statuses keep Pending and Completed", (await call("/api/lookups", admin, "PATCH", { stageStatuses: ["Pending", "Done"] })).status === 400);
  check("TXN entry window editable", (await call("/api/lookups", admin, "PATCH", { txnEntryDays: 45 })).status === 200);
  const lu = (await call("/api/lookups", admin)).data.lookups;
  check("lookups return effective defaults", Array.isArray(lu.denos) && lu.denos.length > 0 && Array.isArray(lu.stageStatuses) && lu.txnEntryDays === 45);
  const pj = (await call("/api/site-projects", admin)).data.projects || [];
  check("project board carries live-register flags", pj.every((p) => typeof p.boardLive === "object"));
  }

  // Phase 4, slice 4: reports and dashboards
  {
  const so4 = await login("so@demo.local", "Sales@123");
  const { readXlsx, writeXlsx } = require("../src/utils/xlsx");
  const allRows = (await call("/api/reports/view/ffm-eod?month=2026-09", admin)).data.rows;
  const none = (await call("/api/reports/view/ffm-eod?month=2026-09&region=Nowhere" + stamp, admin)).data.rows;
  check("report region filter narrows rows", allRows.length > 0 && none.length === 0);
  const byPath = (await call("/api/reports/view/ffm-eod?month=2026-09&fundingPath=Axis", admin)).data.rows;
  check("report funding-path filter keeps matching ATMs", byPath.some((r) => r.atmId === "DEMO0001") && byPath.length <= allRows.length);
  const cbrRange = (await call("/api/reports/view/cbr1?month=2026-09&from=2026-09-29&to=2026-09-30", admin)).data.rows;
  check("report date range drops rows outside it", cbrRange.every((r) => !r.date || /^(29|30)/.test(r.date)));
  check("report filter options listed", (await call("/api/reports/filters", admin)).data.fundingPaths.includes("Axis"));
  const rx = await call("/api/reports/view/cbr1?month=2026-09&xlsx=1", admin);
  const sheet = rx.status === 200 ? readXlsx(Buffer.from(rx.data.data, "base64")) : [];
  check("report Excel export is a real workbook", rx.status === 200 && /sheet/.test(rx.data.mime) && String((sheet[0] || [])[0] || "").length > 0);
  check("franchisee without Export cannot download Excel", (await call("/api/reports/view/cbr1?month=2026-09&xlsx=1", fran)).status === 403);

  const lm = (await call("/api/report-lists/meta", admin)).data;
  check("report lists offered", ["txn-region", "txn-client", "franchise-consolidated", "franchises", "emails", "inspections", "cbr-eod"].every((k) => lm.kinds.some((x) => x.key === k)));
  let listOk = true;
  for (const k of lm.kinds.map((x) => x.key)) {
    const r = await call("/api/report-lists/" + k + "?month=2026-09", admin);
    if (r.status !== 200 || !Array.isArray(r.data.rows)) listOk = false;
  }
  check("every report list loads", listOk);
  const tr = (await call("/api/report-lists/txn-region?month=2026-09", admin)).data;
  check("region-wise TXN totals", tr.columns.includes("totalAmount") && tr.rows.length > 0);
  const lx = await call("/api/report-lists/franchise-consolidated?month=2026-09&xlsx=1", admin);
  check("consolidated firm view exports Excel", lx.status === 200 && readXlsx(Buffer.from(lx.data.data, "base64")).length >= 2);
  const frCons = (await call("/api/report-lists/franchise-consolidated?month=2026-09", fran)).data.rows || [];
  check("franchisee sees only own firm in consolidated view", frCons.length >= 1 && frCons.every((r) => r.firm === "Demo Franchisee"));
  check("field staff cannot open report lists", (await call("/api/report-lists/emails", so4)).status === 403);
  check("client filter on lists", (await call("/api/report-lists/inspections?month=2026-09&client=Nowhere" + stamp, admin)).data.rows.length === 0);

  const ov = await call("/api/dashboard/overview", admin);
  check("overview dashboard: agreements, inspections, field team, business", ov.status === 200 && "Agreements pending" in ov.data.totals && "Inspections this month" in ov.data.totals && "Field visits today" in ov.data.totals && "TXN amount this month ₹" in ov.data.totals);
  check("overview dashboard has trend series", ov.data.trends.length === 2 && ov.data.trends[0].series[0].points.length === 6);
  const cd = (await call("/api/dashboard/complaints", admin)).data;
  check("complaint dashboard trend: raised vs resolved 30 days", cd.trends[0].series.length === 2 && cd.trends[0].series[0].points.length === 30);
  check("complaint dashboard region filter", (await call("/api/dashboard/complaints?region=Nowhere" + stamp, admin)).data.totals.Total === 0);
  check("franchisee has no overview dashboard", (await call("/api/dashboard/overview", fran)).status === 403);

  const pRows = [["franchise", "month", "amount", "revenue", "expenses"], [othName, "2026-12", 500, 1000, 3000]];
  const px = await call("/api/imports", fin, "POST", { template: "payout", fileName: "payout.xlsx", xlsx: writeXlsx(pRows).toString("base64") });
  check("payout Excel upload accepted", px.status === 200 && px.data.batch.accepted === 1);
  const pnl = (await call("/api/finance/pnl?from=2026-10&to=2026-12", admin)).data;
  const oth4 = pnl.rows.find((r) => r.franchise === othName);
  check("P&L month uses revenue − expenses − charge-backs", oth4 && oth4.months.some((m) => m.month === "2026-12" && m.profit === -2000 && m.revenue === 1000));
  check("P&L ranks franchises and lists losses", pnl.rows.every((r, i) => r.rank === i + 1) && Array.isArray(pnl.inLoss));
  check("franchisee P&L shows own franchise only", ((await call("/api/finance/pnl", fran)).data.rows || []).every((r) => r.franchise === "Demo Franchisee"));
  check("P&L export needs Export", (await call("/api/finance/pnl?csv=1", fran)).status === 403 && (await call("/api/finance/pnl?csv=1", admin)).status === 200);
  }

  // Phase 4, slice 5: cross-cutting
  {
  const companyA = (await call("/api/auth/me", admin)).data.user.companyId;
  const mk = async (suffix, extra) => {
    const loginId = "s5" + suffix + stamp + "@demo.local";
    const r = await call("/api/users", admin, "POST", { login: loginId, password: "Passw0rd!1", name: "S5 " + suffix, hierarchy: "SubAdmin", ...extra });
    await call("/api/users/" + r.data.id + "/activate", admin, "PATCH", {});
    return { id: r.data.id, login: loginId };
  };

  const own = await mk("own", { recordScope: "own" });
  const ownT = await login(own.login, "Passw0rd!1");
  const allComplaints = (await call("/api/complaints?view=", admin)).data.complaints;
  const mine = (await call("/api/complaints?view=", ownT)).data.complaints;
  check("own-records user sees none of the others' complaints", allComplaints.length > 0 && mine.length === 0);
  check("own-records user cannot open someone else's complaint", (await call("/api/complaints/" + allComplaints[0]._id, ownT)).status === 403);
  check("user list shows record level", (await call("/api/users", admin)).data.users.find((u) => u._id === own.id).recordScope === "own");
  check("bad record level refused", (await call("/api/users/" + own.id, admin, "PATCH", { recordScope: "mine" })).status === 400);

  await call("/api/users/" + own.id, admin, "PATCH", { recordScope: "all", scopeAtmIds: "DEMO0001" });
  const atmT = await login(own.login, "Passw0rd!1");
  const seen = (await call("/api/atms", atmT)).data.atms || [];
  check("ATM-scoped user sees only listed ATMs", seen.length >= 1 && seen.every((a) => a.atmId === "DEMO0001"));
  await call("/api/users/" + own.id, admin, "PATCH", { scopeAtmIds: "" });

  const p2 = await call("/api/projects", admin, "POST", { name: "S5 project " + stamp, companyId: companyA });
  const scoped = await mk("proj", { projectIds: [p2.data.id] });
  const scopedT = await login(scoped.login, "Passw0rd!1");
  const appsAll = (await call("/api/applications", admin)).data.applications;
  const appsScoped = (await call("/api/applications", scopedT)).data.applications;
  check("project-scoped staff do not see blank or other-project applications", appsAll.length > 0 && appsScoped.every((a) => a.projectId === p2.data.id));
  const newApp = await call("/api/applications", scopedT, "POST", { siteLocationName: "S5 site " + stamp });
  const newRow = (await call("/api/applications", admin)).data.applications.find((a) => a._id === newApp.data.id);
  check("new application takes the creator's project", newRow && newRow.projectId === p2.data.id);
  check("LOI list is project-scoped too", ((await call("/api/lois", scopedT)).data.lois || []).every((l) => l.projectId === p2.data.id));

  check("Sub Admin cannot turn off someone's MFA", (await call("/api/users/" + own.id, sub, "PATCH", { mfaRequired: false })).status === 403);
  check("Admin turns off MFA for a user", (await call("/api/users/" + own.id, admin, "PATCH", { mfaRequired: false })).status === 200);
  const direct = await call("/api/auth/login", null, "POST", { login: own.login, password: "Passw0rd!1" });
  check("MFA-off user signs in with password only", !!direct.data.token && !direct.data.ticket);
  await call("/api/users/" + own.id, admin, "PATCH", { mfaRequired: true });

  check("Sub Admin cannot relax franchise MFA", (await call("/api/companies/" + companyA + "/security", sub, "PATCH", { mfaRelaxFranchise: true })).status === 403);
  await call("/api/companies/" + companyA + "/security", admin, "PATCH", { mfaRelaxFranchise: true });
  const frDirect = await call("/api/auth/login", null, "POST", { login: "franchisee@demo.local", password: "Fran@123" });
  const offDirect = await call("/api/auth/login", null, "POST", { login: "subadmin@demo.local", password: "SubAdmin@123" });
  check("relaxed policy: franchise user skips MFA, office user does not", !!frDirect.data.token && !!offDirect.data.ticket);
  await call("/api/companies/" + companyA + "/security", admin, "PATCH", { mfaRelaxFranchise: false });
  check("policy restored: franchise user needs MFA again", !!(await call("/api/auth/login", null, "POST", { login: "franchisee@demo.local", password: "Fran@123" })).data.ticket);

  const rc = await call("/api/auth/recovery-codes", ownT, "POST", {});
  check("8 recovery codes issued once", rc.status === 200 && rc.data.codes.length === 8);
  const t1 = await call("/api/auth/login", null, "POST", { login: own.login, password: "Passw0rd!1" });
  const viaCode = await call("/api/auth/mfa", null, "POST", { ticket: t1.data.ticket, recoveryCode: rc.data.codes[0] });
  check("recovery code signs in", !!viaCode.data.token);
  const t2 = await call("/api/auth/login", null, "POST", { login: own.login, password: "Passw0rd!1" });
  check("recovery code works only once", (await call("/api/auth/mfa", null, "POST", { ticket: t2.data.ticket, recoveryCode: rc.data.codes[0] })).status === 401);
  check("recovery use is audited", (await call("/api/audit?event=RecoveryCodeUsed", admin)).data.events.some((e) => e.login === own.login));
  check("recovery hashes never leave the server", !JSON.stringify((await call("/api/users", admin)).data.users.find((u) => u._id === own.id)).includes("hash"));

  const setup = await call("/api/auth/totp/setup", ownT, "POST", {});
  check("authenticator setup shows key and otpauth URI", /^[A-Z2-7]{32}$/.test(setup.data.key) && setup.data.uri.startsWith("otpauth://totp/"));
  check("wrong code does not enable authenticator", (await call("/api/auth/totp/enable", ownT, "POST", { code: "000000" })).status === 400);
  const secret = require("../src/modules/auth/mfa.service").base32Decode(setup.data.key);
  check("authenticator enabled with a live code", (await call("/api/auth/totp/enable", ownT, "POST", { code: require("../src/modules/auth/mfa.service").totp(secret) })).status === 200);
  const t3 = await call("/api/auth/login", null, "POST", { login: own.login, password: "Passw0rd!1" });
  check("login asks for the authenticator code, no demo OTP", t3.data.method === "totp" && !t3.data.otpDemo);
  check("authenticator code signs in", !!(await call("/api/auth/mfa", null, "POST", { ticket: t3.data.ticket, otp: require("../src/modules/auth/mfa.service").totp(secret) })).data.token);
  check("TOTP secret never leaves the server", !JSON.stringify((await call("/api/users", admin)).data.users).includes("totpSecret"));
  check("Admin resets a user's MFA", (await call("/api/users/" + own.id, admin, "PATCH", { resetMfa: true })).status === 200);
  check("after reset the user is back on one-time codes", (await call("/api/auth/login", null, "POST", { login: own.login, password: "Passw0rd!1" })).data.method === "code");

  const coB = (await call("/api/companies", dexter)).data.companies.find((c) => c._id !== companyA);
  check("Admin cannot move a record into a company they do not hold", (await call("/api/company-move", admin, "POST", { type: "user", id: own.id, targetCompanyId: coB ? coB._id : companyA, reason: "x" })).status >= 400);
  check("company move needs a reason", (await call("/api/company-move", dexter, "POST", { type: "user", id: own.id, targetCompanyId: coB._id })).status === 400);
  check("Dexter moves a user to company B", (await call("/api/company-move", dexter, "POST", { type: "user", id: own.id, targetCompanyId: coB._id, reason: "transfer " + stamp })).status === 200);
  check("moved user no longer listed in company A", !(await call("/api/users", admin)).data.users.some((u) => u._id === own.id));
  check("company move audited with before/after", (await call("/api/audit?event=CompanyMoved", admin)).data.events.some((e) => e.before && String(e.before.companyId) === companyA && /transfer/.test(e.work)));
  await call("/api/company-move", dexter, "POST", { type: "user", id: own.id, targetCompanyId: companyA, reason: "back " + stamp });

  check("Print Screen event recorded", (await call("/api/audit/client-event", fran, "POST", { kind: "PrintScreen", page: "reports" })).status === 200);
  check("repeat within 30 s is deduped", (await call("/api/audit/client-event", fran, "POST", { kind: "PrintScreen" })).data.deduped === true);
  check("unknown client event refused", (await call("/api/audit/client-event", fran, "POST", { kind: "Hack" })).status === 400);
  const drafts = await call("/api/mail", admin, "POST", { complaintId: allComplaints[0]._id, draft: true, subject: "s5 draft " + stamp });
  await call("/api/mail/" + drafts.data.id, admin, "PATCH", { action: "discard" });
  check("discarding a mail draft is audited", (await call("/api/audit?event=MailDraftDiscarded", admin)).data.events.some((e) => /s5 draft/.test(e.work)));
  await call("/api/lookups", admin, "PATCH", { txnEntryDays: 44 });
  await call("/api/lookups", admin, "PATCH", { txnEntryDays: 45 });
  check("lookup edit keeps the before value", (await call("/api/audit?event=LookupChanged", admin)).data.events.some((e) => e.before && e.before.txnEntryDays === 44));
  check("audit purge is off by default", (await call("/api/audit/meta", admin)).data.policy.purgeEnabled === false);

  const ns = await call("/api/notices/settings", admin);
  check("notice rules listed per event with channels", ns.status === 200 && ns.data.settings.task.channels.includes("in-app"));
  check("Sub Admin cannot change notice rules", (await call("/api/notices/settings", sub, "PATCH", { settings: { task: { on: false } } })).status === 403);
  check("unknown channel refused", (await call("/api/notices/settings", admin, "PATCH", { settings: { task: { channels: ["pigeon"] } } })).status === 400);
  const off = await call("/api/notices/settings", admin, "PATCH", { settings: { share: { on: false } } });
  check("event switched off", off.status === 200 && off.data.settings.share.on === false);
  await call("/api/notices/settings", admin, "PATCH", { settings: { share: { on: true } } });

  const sc = await call("/api/register-columns", admin, "POST", { register: "complaint", name: "Field check " + stamp, type: "status", options: "Pending, Done" });
  check("status column needs 2+ options", (await call("/api/register-columns", admin, "POST", { register: "complaint", name: "one" + stamp, type: "status", options: "Only" })).status === 400);
  check("status column created on complaints", sc.status === 200);
  check("status value must be an option", (await call("/api/registers/complaint/" + allComplaints[0]._id + "/extra", admin, "PATCH", { extra: { ["Field check " + stamp]: "Maybe" } })).status === 400);
  check("status value saved", (await call("/api/registers/complaint/" + allComplaints[0]._id + "/extra", admin, "PATCH", { extra: { ["Field check " + stamp]: "Done" } })).status === 200);
  const fc = await call("/api/register-columns", admin, "POST", { register: "txn", name: "Slip " + stamp, type: "file" });
  const txnRow = (await call("/api/ops/txn?month=2026-09", admin)).data.rows[0];
  const up = await call("/api/registers/txn/" + txnRow._id + "/extra", admin, "PATCH", { extra: { ["Slip " + stamp]: { fileName: "slip.txt", data: b64("slip " + stamp) } } });
  const slip = up.data.extra && up.data.extra["Slip " + stamp];
  check("file column on TXN stores a real file", fc.status === 200 && slip && slip.docId);
  const back = await call("/api/registers/txn/" + txnRow._id + "/file/" + slip.docId, admin);
  check("file column downloads the same bytes (GridFS)", Buffer.from(back.data.data || "", "base64").toString() === "slip " + stamp);
  check("franchise user cannot edit custom columns", (await call("/api/registers/txn/" + txnRow._id + "/extra", fran, "PATCH", { extra: {} })).status === 403);
  await call("/api/register-columns/" + sc.data.id, admin, "DELETE");
  await call("/api/register-columns/" + fc.data.id, admin, "DELETE");

  const v1 = await call("/api/affidavit-formats", admin, "POST", { model: "Emerald", fileName: "e1.pdf", data: b64("%PDF-1.4 v1 " + stamp) });
  const v2 = await call("/api/affidavit-formats", admin, "POST", { model: "Emerald", fileName: "e2.pdf", data: b64("%PDF-1.4 v2 " + stamp) });
  const fmts = (await call("/api/affidavit-formats", admin)).data.formats.filter((f) => f.model === "Emerald");
  check("affidavit format versions count up", v2.data.version === v1.data.version + 1);
  check("only the newest format is current", fmts.filter((f) => f.current).length === 1 && fmts.find((f) => f.current)._id === v2.data.id);
  check("older format can be made current", (await call("/api/affidavit-formats/" + v1.data.id + "/current", admin, "PATCH")).status === 200 && (await call("/api/affidavit-formats", admin)).data.formats.find((f) => f._id === v1.data.id).current === true);
  const fmtFile = await call("/api/affidavit-formats/" + v1.data.id + "/file", admin);
  check("affidavit format file served from GridFS", Buffer.from(fmtFile.data.data, "base64").toString().includes("v1 " + stamp));
  }

  // Phase 4, slice 6: outside-service adapters (all off by default)
  {
  const ad = await call("/api/adapters", admin);
  const keys = (ad.data.adapters || []).map((a) => a.key);
  check("adapter status cards for every outside service", ["mail", "inbound", "sms", "chat", "otp", "idcheck", "hrms", "ppt"].every((k) => keys.includes(k)));
  check("adapters are off by default", ad.data.adapters.filter((a) => a.key !== "ppt").every((a) => !a.on));
  check("adapter status is Admin only", (await call("/api/adapters", fran)).status === 403);
  for (const k of ["mail", "inbound", "sms", "chat", "otp", "idcheck", "hrms"]) {
    const t = await call("/api/adapters/" + k + "/test", admin, "POST", { to: k === "mail" ? "x@demo.local" : "9999999999" });
    check("test button reports not configured: " + k, t.status === 200 && t.data.ok === false && /^not configured/.test(t.data.message));
  }
  check("unknown adapter 404", (await call("/api/adapters/nope/test", admin, "POST", {})).status === 404);
  check("inbound webhook closed while off", (await call("/api/mail/inbound-hook", null, "POST", { from: "a@b.c" })).status === 404);
  check("HRMS webhook closed while off", (await call("/api/hrms/webhook", null, "POST", { employees: [] })).status === 404);

  check("PPT recipients validated", (await call("/api/adapters/settings", admin, "PATCH", { pptMailTo: "not-an-address" })).status === 400);
  check("PPT recipients saved", (await call("/api/adapters/settings", admin, "PATCH", { pptMailTo: "ops@demo.local, md@demo.local" })).status === 200);
  check("PPT card shows recipients", (await call("/api/adapters", admin)).data.adapters.find((a) => a.key === "ppt").on === true);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const stageDoc = await call("/api/documents", admin, "POST", { parentType: "project", parentId: pid, type: "Stage: Site Survey", fileName: "stage.png", data: png, lat: "22.71", lng: "75.85", capturedAt: new Date().toISOString() });
  const deck = await call("/api/site-projects/" + pid + "/pptx", admin, "POST", {});
  const { unzip } = require("../src/utils/xlsx");
  const parts = deck.status === 200 ? unzip(Buffer.from(deck.data.data, "base64")) : {};
  const names = Array.isArray(parts) ? parts.map((p) => p.name) : Object.keys(parts);
  check("project PPT is a pptx zip with slides", names.includes("ppt/presentation.xml") && names.includes("ppt/slides/slide1.xml"));
  check("PPT has a slide per stage photo", deck.data.photos >= 1 && names.some((n) => n.startsWith("ppt/media/")));
  const deckMail = await call("/api/site-projects/" + pid + "/pptx", admin, "POST", { mail: true });
  check("PPT mail queued with the deck attached", deckMail.status === 200 && !!deckMail.data.mailId);
  check("field franchise cannot build the PPT", (await call("/api/site-projects/" + pid + "/pptx", fran, "POST", {})).status !== 200);

  const idc = await call("/api/documents/" + d1.data.id + "/id-check", admin, "POST", {});
  check("ID check stored on the KYC document while off", idc.status === 200 && idc.data.identityCheck.status === "Not configured" && idc.data.identityCheck.provider === "off");
  check("ID check only for PAN / Aadhaar / DL", stageDoc.status === 200 && (await call("/api/documents/" + stageDoc.data.id + "/id-check", admin, "POST", {})).status === 400);
  check("franchise cannot run the ID check", (await call("/api/documents/" + d1.data.id + "/id-check", fran, "POST", {})).status === 403);

  const net = require("net");
  let got = "";
  const fake = net.createServer((s) => {
    s.write("220 fake ESMTP\r\n");
    let inData = false;
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            s.write("250 queued\r\n");
          } else got += line + "\n";
          continue;
        }
        if (/^EHLO/i.test(line)) s.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH PLAIN/i.test(line)) s.write("235 ok\r\n");
        else if (/^MAIL FROM/i.test(line)) s.write("250 ok\r\n");
        else if (/^RCPT TO:<bad@/i.test(line)) s.write("550 no such user\r\n");
        else if (/^RCPT TO/i.test(line)) s.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) {
          inData = true;
          s.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) s.end("221 bye\r\n");
        else s.write("500 what\r\n");
      }
    });
  });
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(fake.address().port), SMTP_USER: "relay@demo.local", SMTP_PASS: "x", SMTP_ALLOW_PLAIN: "on", MAIL_FROM: "crm@demo.local" });
  const { buildMime } = require("../src/adapters/mail-mime");
  const mime = buildMime({ from: "crm@demo.local", to: ["a@demo.local"], cc: [], subject: "Hindi नमस्ते", body: ".dot line\nsecond" }, "<t@demo.local>", [{ name: "a.txt", mime: "text/plain", data: Buffer.from("hello") }]);
  const sent = await require("../src/adapters/smtp").smtpSend({ from: "crm@demo.local", rcpt: ["a@demo.local"], data: mime }).catch((e) => ({ error: e.message }));
  check("SMTP client delivers through a relay (AUTH PLAIN)", sent.ok === true && got.includes("Message-ID: <t@demo.local>") && got.includes("=?UTF-8?B?"));
  check("SMTP attachment and dot-stuffing", got.includes('filename="a.txt"') && got.includes("multipart/mixed"));
  const bad = await require("../src/adapters/smtp").smtpSend({ from: "crm@demo.local", rcpt: ["bad@demo.local"], data: mime }).catch((e) => ({ error: e.message }));
  check("SMTP permanent failure surfaces the 5xx code", /^550/.test(bad.error || ""));
  fake.close();
  const parsed = require("../src/adapters/imap").parseRfc822(Buffer.from("From: FR <fr@demo.local>\r\nTo: desk@demo.local\r\nSubject: =?UTF-8?B?" + Buffer.from("Re: DKT test").toString("base64") + "?=\r\nMessage-ID: <m1@x>\r\nIn-Reply-To: <p1@x>\r\nContent-Type: multipart/alternative; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20desk\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--b1--\r\n"));
  check("inbound mail parser reads headers and the text part", parsed.from === "fr@demo.local" && parsed.subject === "Re: DKT test" && parsed.inReplyTo === "<p1@x>" && parsed.body.startsWith("Hello desk"));
  const sig = require("../src/modules/hrms/hrms.service").verifySignature;
  const crypto = require("crypto");
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = Buffer.from('{"employees":[]}');
  const good = crypto.createHmac("sha256", "s3").update(ts + "." + raw.toString()).digest("hex");
  check("webhook signature accepted when valid", sig("s3", { headers: { "x-af-timestamp": ts, "x-af-signature": "sha256=" + good }, rawBody: raw }));
  check("webhook signature rejected when tampered", !sig("s3", { headers: { "x-af-timestamp": ts, "x-af-signature": "sha256=" + good }, rawBody: Buffer.from('{"employees":[1]}') }));
  }

  check("no Lead endpoint", (await call("/api/leads", admin)).status === 404);
  check("seed franchise tree present", frs.length >= 3);

  console.log(failed ? failed + " failed" : "all passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
