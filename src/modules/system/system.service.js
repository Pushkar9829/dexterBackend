async function getHealth(ctx) {
  return { status: 200, body: { ok: true, stack: "node-express-mongodb" } };
}

let openApiCache = null;

async function getOpenApi(ctx) {
  if (!openApiCache) openApiCache = require("../../utils/openapi").buildOpenApi(require("../../app").ROUTERS);
  return { status: 200, body: openApiCache };
}

module.exports = { getHealth, getOpenApi };
