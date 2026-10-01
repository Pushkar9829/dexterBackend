// Sample records for a freshly seeded database, created through the API so every rule applies.
// Run after `npm run seed` and an API restart: `npm run demo-data`.
require("../src/config/env");
const B = process.env.API_URL || "http://127.0.0.1:4000";

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
  if (!a.data.ticket) throw new Error("login failed " + l + " " + JSON.stringify(a.data));
  const m = await call("/api/auth/mfa", null, "POST", { ticket: a.data.ticket, otp: a.data.otpDemo });
  if (!m.data.token) throw new Error("MFA failed " + l);
  return m.data.token;
}

const b64 = (s) => Buffer.from(s).toString("base64");
const istDay = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);
let problems = 0;
function need(label, r) {
  const ok = r && r.status >= 200 && r.status < 300;
  if (!ok) problems++;
  console.log((ok ? "ok   " : "FAIL ") + label + (ok ? "" : " " + (r ? r.status + " " + JSON.stringify(r.data) : "")));
  return r && r.data;
}

(async () => {
  const admin = await login("admin@demo.local", "Admin@123");
  const fran = await login("franchisee@demo.local", "Fran@123");
  const ops = await login("ops@demo.local", "Ops@12345");
  const verifier = await login("verifier@demo.local", "Verify@123");
  const finance = await login("finance@demo.local", "Fin@123");
  const users = (await call("/api/users", admin)).data.users;
  const uid = (l) => users.find((u) => u.login === l)._id;
  const me = (await call("/api/auth/me", fran)).data.user;

  need("site master row", await call("/api/sites", admin, "POST", { siteId: "SITE-IND-001", name: "Vijay Nagar Main Road", city: "Indore", franchiseId: me.franchiseId }));

  const app = need("application (Demo Franchisee)", await call("/api/applications", fran, "POST", { siteLocationName: "Vijay Nagar Main Road", city: "Indore", state: "Madhya Pradesh", pin: "452010", address: "12, Vijay Nagar Main Road, Scheme 54", siteType: "Full Shop", model: "Sapphire", landlordName: "Ramesh Patel", contactNumber: "9826012345", siteId: "SITE-IND-001" }));
  const kyc = need("KYC PAN upload", await call("/api/documents", fran, "POST", { parentId: app.id, type: "PAN", fileName: "pan.pdf", data: b64("%PDF-1.4 demo PAN") }));
  need("KYC Aadhaar upload", await call("/api/documents", fran, "POST", { parentId: app.id, type: "Aadhaar", fileName: "aadhaar.pdf", data: b64("%PDF-1.4 demo Aadhaar") }));
  need("application submitted", await call("/api/applications/" + app.id, fran, "PATCH", { submit: true }));
  need("KYC verified", await call("/api/documents/" + kyc.id + "/verify", verifier, "PATCH", { approve: true }));
  need("application approved", await call("/api/applications/" + app.id, admin, "PATCH", { approve: true, siteNumber: "IND-001" }));
  const loi = need("LOI", await call("/api/lois", admin, "POST", { loiCode: "LOI-IND-001", applicationId: app.id }));
  need("LOI approved", await call("/api/lois/" + loi.id, verifier, "PATCH", { approve: true }));
  const agr = need("agreement", await call("/api/agreements", admin, "POST", { applicationId: app.id }));
  need("agreement Link Shared", await call("/api/agreements/" + agr.id, admin, "PATCH", { status: "Link Shared" }));
  need("agreement term", await call("/api/agreements/" + agr.id, admin, "PATCH", { signedDate: "2026-09-01", startDate: "2026-09-01", endDate: "2031-08-31" }));

  const proj = need("project from approved site", await call("/api/site-projects", admin, "POST", { applicationId: app.id }));
  const meta = (await call("/api/site-projects/meta", admin)).data;
  need("stage 1 approved", await call("/api/site-projects/" + proj.id + "/stages/0/approve", admin, "POST", {}));
  for (let i = 1; i <= 4; i++) {
    await call("/api/documents", fran, "POST", { parentType: "project", parentId: proj.id, type: "Stage: " + meta.stages[i], fileName: "stage" + i + ".jpg", data: b64("jpeg"), lat: "22.75", lng: "75.89", capturedAt: new Date().toISOString() });
    need("stage " + (i + 1) + " approved (" + meta.stages[i] + ")", await call("/api/site-projects/" + proj.id + "/stages/" + i + "/approve", verifier, "POST", {}));
  }

  const A = "DEMO0001";
  let opening = 500000;
  for (const d of [-3, -2, -1]) {
    const D = istDay(d);
    need("TXN " + D, await call("/api/ops/txn", ops, "PUT", { atmId: A, date: D, cashCount: 40 + d, cashAmount: 80000 + d * 1000, balanceCount: 12, nonCashCount: 3 }));
    need("CBR 1 " + D, await call("/api/ops/cbr1", ops, "PUT", { atmId: A, date: D, deno: 500, indent: "IND-" + D, eodTime: "23:00", openingNotes: opening / 500, dispensedNotes: 160 }));
    need("WLA funding " + D, await call("/api/ops/funding", ops, "PUT", { type: "WLA", atmId: A, date: D, openingWla: 300000, fund: 100000, withdrawal: 80000, loadingCbr: 80000 }));
    const eod = need("EOD " + D, await call("/api/ops/eod", ops, "PUT", { atmId: A, date: D, eodTime: "23:00", opening, dispenseMachine: 80000, dispenseApna: 80000, physicalNotes: { 500: (opening - 80000) / 500 } }));
    const row = (await call("/api/ops/eod?date=" + D, ops)).data.rows.find((r) => r.atmId === A);
    if (row && d < -1) {
      need("EOD submitted " + D, await call("/api/ops/eod/" + row._id + "/submit", ops, "POST", {}));
      need("EOD verified " + D, await call("/api/ops/eod/" + row._id + "/verify", verifier, "POST", {}));
    }
    opening = (eod && eod.closing) || opening - 80000;
  }

  const tk = need("complaint (franchisee)", await call("/api/complaints", fran, "POST", { atmId: A, problemType: "Dispenser", subject: "Cash not dispensing after 9 pm", priority: "High" }));
  need("complaint assigned", await call("/api/complaints/" + tk.id, ops, "PATCH", { action: "assign", ownerName: "Service Desk", ownerUserId: uid("ops@demo.local") }));
  need("task", await call("/api/tasks", admin, "POST", { title: "Collect signed agreement for Vijay Nagar", assigneeId: uid("executive@demo.local"), priority: "Medium", dueAt: new Date(Date.now() + 3 * 86400000).toISOString() }));
  need("inspection assigned", await call("/api/inspections", admin, "POST", { atmId: A, officerId: uid("inspector@demo.local"), date: istDay(1), type: "Routine" }));
  need("security deposit", await call("/api/finance/security-deposits", finance, "POST", { franchiseId: me.franchiseId, label: "SD Vijay Nagar", amountDue: 200000 }));

  console.log(problems ? problems + " step(s) failed" : "demo data loaded");
  process.exit(problems ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
