const fs = require("fs");
const path = require("path");
const { BSON } = require("mongodb");
const { connect, dbName } = require("../src/config/db");

async function main() {
  const db = await connect();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "backups", dbName + "-" + stamp));
  fs.mkdirSync(dir, { recursive: true });
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const manifest = { db: dbName, at: new Date().toISOString(), collections: {} };
  for (const name of cols) {
    const file = path.join(dir, name + ".ejson");
    const out = fs.createWriteStream(file);
    let n = 0;
    for await (const doc of db.collection(name).find({})) {
      out.write(BSON.EJSON.stringify(doc, { relaxed: false }) + "\n");
      n++;
    }
    await new Promise((r) => out.end(r));
    const indexes = (await db.collection(name).indexes()).filter((i) => i.name !== "_id_");
    manifest.collections[name] = { documents: n, indexes };
    console.log(name.padEnd(28) + n);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("backup written to " + dir);
  process.exit(0);
}

main().catch((err) => {
  console.error("backup failed:", err.message);
  process.exit(1);
});
