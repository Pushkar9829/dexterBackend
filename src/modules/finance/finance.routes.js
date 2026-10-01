const { Router } = require("express");
const controller = require("./finance.controller");
const { requireAction, requireAuth } = require("../../middlewares/rbac");

const view = requireAction("View", "CRM-04");

const router = Router();

router.get("/api/finance/meta", requireAuth, controller.getFinanceMeta);
router.get("/api/finance/desk", requireAuth, view, controller.getFinanceDesk);
router.get("/api/finance/gst-bills/preview", requireAuth, view, controller.getFinanceGstPreview);
router.get("/api/finance/chargebacks", requireAuth, view, controller.getFinanceChargebacks);
router.post("/api/finance/chargebacks", requireAuth, controller.postFinanceChargebacks);
router.patch("/api/finance/chargebacks/:id", requireAuth, controller.patchFinanceChargebacksById);
router.get("/api/finance/security-deposits", requireAuth, view, controller.getFinanceSecurityDeposits);
router.post("/api/finance/security-deposits", requireAuth, controller.postFinanceSecurityDeposits);
router.post("/api/finance/security-deposits/:id/settle", requireAuth, controller.postFinanceSecurityDepositsByIdSettle);
router.get("/api/finance/payments", requireAuth, view, controller.getFinancePayments);
router.post("/api/finance/payments", requireAuth, requireAction("Create", "CRM-04"), controller.postFinancePayments);
router.patch("/api/finance/payments/:id", requireAuth, controller.patchFinancePaymentsById);
router.get("/api/finance/bank-statements", requireAuth, view, controller.getFinanceBankStatements);
router.post("/api/finance/bank-statements", requireAuth, requireAction("Create", "CRM-04"), controller.postFinanceBankStatements);
router.patch("/api/finance/bank-statements/:id", requireAuth, controller.patchFinanceBankStatementsById);
router.get("/api/finance/tds", requireAuth, view, controller.getFinanceTds);
router.post("/api/finance/tds", requireAuth, controller.postFinanceTds);
router.get("/api/finance/gst-bills", requireAuth, view, controller.getFinanceGstBills);
router.put("/api/finance/gst-bills", requireAuth, controller.putFinanceGstBills);
router.patch("/api/finance/gst-bills/:id", requireAuth, controller.patchFinanceGstBillsById);
router.get("/api/finance/payout-accounts", requireAuth, view, controller.getFinancePayoutAccounts);
router.put("/api/finance/payout-accounts", requireAuth, requireAction("Create", "CRM-04"), controller.putFinancePayoutAccounts);
router.patch("/api/finance/payout-accounts/:id", requireAuth, controller.patchFinancePayoutAccountsById);
router.get("/api/finance/payouts", requireAuth, view, controller.getFinancePayouts);
router.get("/api/finance/pnl", requireAuth, view, controller.getFinancePnl);
router.patch("/api/finance/payouts/:id", requireAuth, controller.patchFinancePayoutsById);
router.get("/api/finance/export", requireAuth, controller.getFinanceExport);

module.exports = router;
