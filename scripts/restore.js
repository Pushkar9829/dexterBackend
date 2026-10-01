const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { BSON } = require("mongodb");
const { connect, dbName } = require("../src/config/db");

async function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : "";
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) {
    console.error("usage: node restore.js <backup folder> --yes   (the folder must contain manifest.json)");
    process.exit(2);
  }
  if (!process.argv.includes("--yes")) {
    console.error("restore REPLACES every collection listed in the backup in database '" + dbName + "'. Re-run with --yes to continue.");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const db = await connect();
  for (const [name, info] of Object.entries(manifest.collections)) {
    const coll = db.collection(name);
    await coll.deleteMany({});
    let batch = [];
    let n = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, name + ".ejson")), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(BSON.EJSON.parse(line, { relaxed: false }));
      if (batch.length === 500) {
        await coll.insertMany(batch, { ordered: false });
        n += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await coll.insertMany(batch, { ordered: false });
      n += batch.length;
    }
    for (const idx of info.indexes || []) {
      const { key, v, ns, ...opts } = idx;
      await coll.createIndex(key, opts).catch((err) => console.error("  index " + idx.name + " on " + name + ": " + err.message));
    }
    const ok = n === info.documents ? "" : "  (expected " + info.documents + ")";
    console.log(name.padEnd(28) + n + ok);
  }
  console.log("restore finished into " + dbName + " from backup taken " + manifest.at);
  process.exit(0);
}

main().catch((err) => {
  console.error("restore failed:", err.message);
  process.exit(1);
});
