// Writes docs/openapi.json from the mounted routes. `node scripts/openapi.js --check` fails when the file is out of date.
const fs = require("fs");
const path = require("path");
const { ROUTERS } = require("../src/app");
const { buildOpenApi } = require("../src/utils/openapi");

const out = path.join(__dirname, "..", "..", "..", "docs", "openapi.json");
const text = JSON.stringify(buildOpenApi(ROUTERS), null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error("docs/openapi.json is out of date: run npm run openapi");
    process.exit(1);
  }
  console.log("docs/openapi.json is up to date");
} else {
  fs.writeFileSync(out, text);
  const spec = JSON.parse(text);
  const ops = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log("wrote " + path.relative(process.cwd(), out) + ": " + Object.keys(spec.paths).length + " paths, " + ops + " operations");
}
