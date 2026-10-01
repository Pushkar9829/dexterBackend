// OpenAPI 3 document generated from the mounted Express routers, so it always matches the code.
// Request / response bodies are not described (services validate by hand); each operation carries its auth rule.

const pkg = require("../../package.json");

const PUBLIC_NOTE = "No session needed (login flow, health or signed webhook).";

function toOpenApiPath(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(method, p) {
  return (
    method +
    p
      .replace(/^\/api\//, "/")
      .split("/")
      .filter(Boolean)
      .map((s) => (s.startsWith(":") ? "By" + s.slice(1, 2).toUpperCase() + s.slice(2) : s.replace(/(^|[-_])(\w)/g, (m, a, c) => c.toUpperCase())))
      .join("")
  );
}

function buildOpenApi(routers) {
  const paths = {};
  const tags = [];
  for (const name of routers) {
    const router = require("../modules/" + name + "/" + name + ".routes");
    tags.push({ name });
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      const p = layer.route.path;
      if (typeof p !== "string") continue;
      const handles = layer.route.stack.map((s) => s.handle);
      const auth = handles.some((h) => h.name === "requireAuth");
      const perm = handles.map((h) => h.permission).filter(Boolean);
      const params = [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      const key = toOpenApiPath(p);
      paths[key] = paths[key] || {};
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m])) {
        const op = {
          tags: [name],
          operationId: operationId(method, p),
          parameters: params,
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
            400: { description: "Validation error: { error }" },
            ...(auth ? { 401: { description: "No or expired session" }, 403: { description: "Role, action, scope or read-only refusal" } } : {}),
            404: { description: "Not found or outside the caller's scope" },
          },
        };
        if (["post", "put", "patch"].includes(method)) op.requestBody = { required: false, content: { "application/json": { schema: { type: "object" } } } };
        if (auth) op.security = [{ bearer: [] }];
        else op.description = PUBLIC_NOTE;
        if (perm.length) {
          op["x-permission"] = perm;
          op.description = "Needs " + perm.map((x) => x.action + " on " + x.module).join(" and ") + ". Services apply further scope checks.";
        } else if (auth) op.description = "Signed-in user; the service applies role and scope checks.";
        paths[key][method] = op;
      }
    }
  }
  return {
    openapi: "3.0.3",
    info: { title: "Dexter ATM Franchise CRM API", version: pkg.version, description: "Generated from the Express routes. Every path is also served under /api/v1/… (same handlers). Authenticate with POST /api/auth/login then /api/auth/mfa, and send the token as `Authorization: Bearer <token>`." },
    servers: [{ url: "/" }],
    tags,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

module.exports = { buildOpenApi, toOpenApiPath, operationId };
