// Lint without extra packages: syntax-check every backend file, then load the app so a broken require fails too.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    bad++;
    console.error(r.stderr.trim());
  }
}

try {
  require("../src/app").createApp();
} catch (err) {
  bad++;
  console.error("app failed to load: " + err.message);
}

console.log(files.length + " files checked, " + bad + " problem(s)");
process.exit(bad ? 1 : 0);
