const { ObjectId } = require("mongodb");
const { connect, col } = require("../src/config/db");
const { hashPassword } = require("../src/utils/password");
const { seedLookups } = require("../src/modules/lookups/lookups.service");

const LOGINS = [];

async function addUser(u, password, label) {
  const p = hashPassword(password);
  const doc = {
    functionalRole: "",
    projectIds: [],
    actions: [],
    modules: [],
    active: true,
    mfaRequired: true,
    seed: true,
    createdAt: new Date(),
    ...u,
    grantedCompanyIds: u.grantedCompanyIds || [u.companyId],
    passwordSalt: p.salt,
    passwordHash: p.hash,
  };
  const r = await col("users").insertOne(doc);
  LOGINS.push({ login: u.login, password, role: label });
  return r.insertedId;
}

async function seed() {
  if (process.env.NODE_ENV === "production") {
    console.error("seed refuses to run with NODE_ENV=production (it drops the whole database)");
    process.exit(2);
  }
  const db = await connect();
  await db.dropDatabase();

  const companyId = new ObjectId();
  await col("companies").insertOne({ _id: companyId, name: "Dexter Demo Company", code: "DEXTER", active: true, indiaOperating: true, seed: true, createdAt: new Date() });
  await seedLookups(companyId);

  const projectId = new ObjectId();
  await col("projects").insertOne({ _id: projectId, companyId, name: "WLA North", active: true, seed: true, createdAt: new Date() });

  const smId = new ObjectId();
  const masterId = new ObjectId();
  const frId = new ObjectId();
  const fr2Id = new ObjectId();
  await col("franchises").insertMany([
    { _id: smId, companyId, name: "Super Master North", layer: "SuperMasterFranchise", status: "Active", superMasterId: null, masterId: null, seed: true, createdAt: new Date() },
    { _id: masterId, companyId, name: "Master Indore", layer: "MasterFranchise", status: "Active", superMasterId: smId, masterId: null, seed: true, createdAt: new Date() },
    { _id: frId, companyId, name: "Demo Franchisee", layer: "Franchise", status: "Active", superMasterId: smId, masterId, seed: true, createdAt: new Date() },
    { _id: fr2Id, companyId, name: "Demo Franchisee Two", layer: "Franchise", status: "Active", superMasterId: smId, masterId, seed: true, createdAt: new Date() },
  ]);

  await col("atms").insertOne({
    companyId,
    atmId: "DEMO0001",
    atmSerialNumber: "SN-DEMO-0001",
    machineTypeModel: "Hyosung 2700",
    model: "Sapphire",
    city: "Indore",
    siteId: "",
    franchiseeName: "Demo Franchisee",
    franchiseId: frId,
    projectId,
    bankName: "Axis",
    cashLiveDate: new Date("2026-09-01T00:00:00Z"),
    seed: true,
    createdAt: new Date(),
  });

  const franchiseModules = ["CRM-02", "CRM-03", "CRM-04", "CRM-05"];
  const officeModules = ["CRM-02", "CRM-03", "CRM-04", "CRM-05", "CRM-06", "CRM-07", "CRM-08"];

  await addUser({ login: "admin@demo.local", mobile: "9000000001", name: "Demo Admin", hierarchy: "Admin", companyId, projectIds: [projectId] }, "Admin@123", "Admin, company A");
  await col("employees").insertOne({ companyId, name: "Demo Admin", department: "Admin", designation: "CRM Admin", reportingManager: "", employmentStatus: "Active", hrmsEmployeeId: "", seed: true, createdAt: new Date() });
  await addUser({ login: "director@demo.local", mobile: "9000000011", name: "Demo Director", hierarchy: "Director", companyId }, "Director@123", "Director (view + approve)");
  await addUser({ login: "subadmin@demo.local", mobile: "9000000012", name: "Demo Sub Admin", hierarchy: "SubAdmin", companyId, projectIds: [projectId] }, "SubAdmin@123", "Sub Admin");

  const basic = ["View", "Create", "Edit"];
  for (const [login, name, role, pass, mobile, modules, actions, label] of [
    ["verifier@demo.local", "Demo Verifier", "Verifier", "Verify@123", "9000000013", officeModules, [...basic, "Approve", "Reject"], "Verifier (KYC, LOI, EOD verify)"],
    ["executive@demo.local", "Demo Executive", "Executive", "Exec@1234", "9000000014", officeModules, basic, "Executive (data entry)"],
    ["ops@demo.local", "Demo Service Ops", "ServiceProjectOps", "Ops@12345", "9000000015", officeModules, [...basic, "Approve", "Assign", "Close", "Export"], "Service / Project Ops (desk, stages, daily ops)"],
    ["so@demo.local", "Demo Sales Officer", "SalesOfficer", "Sales@123", "9000000004", ["CRM-02", "CRM-03", "CRM-05", "CRM-06"], basic, "Sales Officer (field visits)"],
    ["inspector@demo.local", "Demo Inspector", "Inspector", "Insp@123", "9000000005", ["CRM-02", "CRM-03", "CRM-05", "CRM-06"], basic, "Inspector (field inspections)"],
    ["finance@demo.local", "Demo Finance", "Finance", "Fin@123", "9000000006", ["CRM-02", "CRM-03", "CRM-04", "CRM-05", "CRM-06", "CRM-07"], [...basic, "Export"], "Finance"],
  ]) {
    await addUser({ login, mobile, name, hierarchy: "SubAdmin", functionalRole: role, companyId, projectIds: [projectId], actions, modules }, pass, label);
  }

  const franActions = ["View", "Create", "Edit"];
  await addUser({ login: "supermaster@demo.local", mobile: "9000000003", name: "Demo Super Master", hierarchy: "SuperMasterFranchise", companyId, franchiseId: smId, projectIds: [projectId], actions: franActions, modules: franchiseModules }, "Super@123", "Super Master Franchise");
  await addUser({ login: "master@demo.local", mobile: "9000000016", name: "Demo Master Indore", hierarchy: "MasterFranchise", companyId, franchiseId: masterId, projectIds: [projectId], actions: franActions, modules: franchiseModules }, "Master@123", "Master Franchise");
  await addUser({ login: "franchisee@demo.local", mobile: "9000000002", name: "Demo Franchisee", hierarchy: "Franchise", companyId, franchiseId: frId, projectIds: [projectId], actions: franActions, modules: franchiseModules }, "Fran@123", "Franchise (owns ATM DEMO0001)");
  await addUser({ login: "franchisee2@demo.local", mobile: "9000000017", name: "Demo Franchisee Two", hierarchy: "Franchise", companyId, franchiseId: fr2Id, projectIds: [projectId], actions: franActions, modules: franchiseModules }, "Fran2@123", "Franchise (sibling, same Master)");

  const companyB = new ObjectId();
  await col("companies").insertOne({ _id: companyB, name: "UAT Company B", code: "UATB", active: true, indiaOperating: true, seed: true, createdAt: new Date() });
  await seedLookups(companyB);
  const frB = new ObjectId();
  await col("franchises").insertOne({ _id: frB, companyId: companyB, name: "Company B Franchisee", layer: "Franchise", status: "Active", superMasterId: null, masterId: null, seed: true, createdAt: new Date() });
  await addUser({ login: "admin-b@demo.local", mobile: "9000000009", name: "Company B Admin", hierarchy: "Admin", companyId: companyB }, "AdminB@123", "Admin, company B");
  await addUser({ login: "franchisee-b@demo.local", mobile: "9000000018", name: "Company B Franchisee", hierarchy: "Franchise", companyId: companyB, franchiseId: frB, actions: franActions, modules: franchiseModules }, "FranB@123", "Franchise, company B");

  await addUser({ login: "dexter@demo.local", mobile: "9000000010", name: "Dexter India Team", hierarchy: "DexterIndiaCompanyTeam", companyId, grantedCompanyIds: [companyId, companyB] }, "Dexter@123", "Dexter India team (companies A and B)");
  await addUser({ login: "dexter-a@demo.local", mobile: "9000000019", name: "Dexter India (A only)", hierarchy: "DexterIndiaCompanyTeam", companyId, grantedCompanyIds: [companyId] }, "DexterA@123", "Dexter India team (company A only)");

  console.log("Seed complete. Database dropped and reloaded. Restart the API (indexes), then run `npm run demo-data` for sample records.");
  console.log("");
  console.log("Login".padEnd(28) + "Password".padEnd(15) + "Role");
  for (const l of LOGINS) console.log(l.login.padEnd(28) + l.password.padEnd(15) + l.role);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
