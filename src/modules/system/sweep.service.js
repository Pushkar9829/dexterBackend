const { sweepCompanyLocked } = require("../../jobs/sweep");
const { isAdmin } = require("../ops/ops.service");
const { writeAudit } = require("../../utils/audit-writer");
const { oid } = require("../../utils/ids");

async function postSystemSweep(ctx) {
  if (!isAdmin(ctx.user)) return { status: 403, body: { error: "Admin only" } };
  const companyId = oid(ctx.user.companyId);
  const r = await sweepCompanyLocked(companyId);
  if (!r) return { status: 409, body: { error: "a sweep is already running for this company; try again shortly" } };
  await writeAudit(ctx, "SweepRun", { companyId, module: "CRM-06", work: JSON.stringify(r) });
  return { status: 200, body: r };
}

module.exports = { postSystemSweep };
