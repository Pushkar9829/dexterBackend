const { can, isFieldStaff, isFranchiseNetwork, isOfficeAdmin, canApproveApplication } = require("../../middlewares/rbac");
const { TASK_DONE } = require("./home.model");
const repo = require("./home.repository");
const { oid } = require("../../utils/ids");
const { applyFranchiseFilter, applyRecordProject, applyRecordScope } = require("../../utils/scope");

// Each source is the same service the page itself calls, so counts match what the user sees after clicking.
async function body(fn, ctx, query = {}) {
  try {
    const r = await fn({ ...ctx, query });
    return r && r.status === 200 ? r.body : null;
  } catch {
    return null;
  }
}

async function getHomeSummary(ctx) {
  const u = ctx.user;
  const me = String(u._id);
  const fr = isFranchiseNetwork(u);
  const field = isFieldStaff(u);
  const items = [];
  const add = (key, title, count, tone, page, focus) => count && items.push({ key, title, count, tone, page, focus: focus || null });

  const jobs = [];

  if (can(u, "View", "CRM-05")) {
    jobs.push(
      body(require("../complaints/complaints.service").getServiceBoard, ctx).then((b) => {
        if (!b) return;
        const board = { page: "service", type: "My work" };
        add("svcMine", "Complaints you own", b.mine.length, "info", "service", board);
        add("svcBreach", "Complaints breaching SLA within 1h", b.breaching.length, "bad", "service", board);
        add("svcUnassigned", "Complaints without an owner", b.unassigned.length, "warn", "service", board);
        add("svcVerify", "Resolved complaints to verify", b.toVerify.length, "warn", "service", board);
        add("svcClose", "Resolved complaints to confirm and close", b.toClose.length, "warn", "service", board);
        add("svcVisits", "Visits due today", b.visitsToday.length, "info", "service", board);
        add("svcVisitsLate", "Visits overdue", b.visitsOverdue.length, "bad", "service", board);
        add("svcInspDue", "Inspections due", b.inspectionsDue.length, "warn", "service", board);
        add("svcInspVerify", "Inspections to verify", b.inspectionsToVerify.length, "warn", "service", board);
      })
    );
  }

  if (can(u, "View", "CRM-04") && !field) {
    jobs.push(
      body(require("../finance/finance.service").getFinanceDesk, ctx).then((b) => {
        if (!b) return;
        for (const s of b.sections) add("fin_" + s.key, s.title, s.count, s.tone, "finance", { page: "finance", type: s.tab });
      })
    );
    const runsOps = can(u, "Create", "CRM-04") && (fr || isOfficeAdmin(u) || ["ServiceProjectOps", "Executive"].includes(u.functionalRole));
    if (runsOps) {
      jobs.push(
        body(require("../ops/ops.service").getOpsDay, ctx).then((b) => {
          if (!b) return;
          const returned = b.rows.filter((r) => r.eod && r.eod.status === "Draft" && r.eod.returnReason).length;
          add("opsReturned", "EODs returned for correction", returned, "bad", "ops", { page: "ops", type: "EOD" });
          add("opsPending", "Live ATMs without a submitted EOD today", b.rows.filter((r) => !r.eod || r.eod.status === "Draft").length - returned, "warn", "ops", { page: "ops", type: "Day board", date: b.date });
        })
      );
    }
    if (canApproveApplication(u) && !fr) {
      jobs.push(
        (async () => {
          const f = { companyId: oid(u.companyId), status: "Submitted", submittedBy: { $ne: u._id } };
          await applyFranchiseFilter(u, f, "franchiseId");
          add("opsVerify", "EODs to verify", await repo.ops_eod.count(f), "warn", "ops", { page: "ops", type: "EOD" });
        })()
      );
    }
  }

  if (can(u, "View", "CRM-06") && !fr) {
    const tasks = require("../tasks/tasks.service");
    jobs.push(
      body(tasks.getTasks, ctx, { view: "mine" }).then((b) => {
        if (!b) return;
        const open = b.rows.filter((t) => !TASK_DONE.includes(t.status));
        add("taskOverdue", "Your tasks overdue", open.filter((t) => t.dueAt && new Date(t.dueAt) < new Date()).length, "bad", "tasks", { page: "tasks", type: "overdue" });
        add("taskMine", "Your open tasks", open.length, "info", "tasks", { page: "tasks", type: "mine" });
      }),
      body(tasks.getTasks, ctx, { view: "review" }).then((b) => b && add("taskReview", "Tasks waiting for your review", b.rows.length, "warn", "tasks", { page: "tasks", type: "review" }))
    );
  }

  if (canApproveApplication(u) && !fr && can(u, "View", "CRM-02")) {
    jobs.push(
      (async () => {
        const f = { companyId: oid(u.companyId), status: "Submitted" };
        await applyFranchiseFilter(u, f, "franchiseId");
        applyRecordProject(u, f);
        await applyRecordScope(u, f, ["createdBy", "ownerUserId"]);
        add("appDecide", "Applications waiting for a decision", await repo.applications.count(f), "warn", "applications", { page: "applications", type: "Submitted" });
      })()
    );
  }

  jobs.push(
    body(require("../notices/notices.service").getNotices, ctx, { unread: "1" }).then((b) => b && add("notices", "Unread notices", b.unread, "info", "notices", null))
  );

  await Promise.all(jobs);
  const rank = { bad: 0, warn: 1, info: 2 };
  items.sort((a, b) => (rank[a.tone] ?? 3) - (rank[b.tone] ?? 3) || b.count - a.count);
  return { status: 200, body: { items, me } };
}

module.exports = { getHomeSummary };
