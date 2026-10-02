import { staffApi } from "@/server/http";
import { Errors } from "@/lib/errors";
import { requirePerm } from "@/server/rbac";
import * as R from "@/server/services/reports";
import type { Currency } from "@prisma/client";
export const GET = staffApi("report.read", async (req, { staff, params }) => {
  const u = new URL(req.url);
  const ccy = (u.searchParams.get("currency") ?? "EGP") as Currency;
  const from = new Date(u.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const to = new Date((u.searchParams.get("to") ?? new Date().toISOString().slice(0, 10)) + "T23:59:59Z");
  switch (params.name) {
    case "trial-balance": requirePerm(staff, "gl.read"); return R.trialBalance();
    case "balance-sheet": requirePerm(staff, "gl.read"); return R.balanceSheet(ccy);
    case "income-statement": requirePerm(staff, "gl.read"); return R.incomeStatement(ccy, from, to);
    case "gl": requirePerm(staff, "gl.read"); return R.glDetail(u.searchParams.get("code") ?? "1100", ccy, from, to);
    case "reconcile": requirePerm(staff, "gl.read"); return R.reconcile();
    case "loan-portfolio": return R.loanPortfolio(staff);
    case "deposits": return R.depositsReport(staff);
    case "aml": return R.amlReport(staff);
    case "teller-cash": return R.tellerCash(staff);
    case "daily": return R.dailyTransactions(staff, u.searchParams.get("date") ?? undefined);
    case "dashboard": return R.dashboard(staff);
    case "atm": return R.atmReport(staff);
    case "cards": return R.cardActivity(staff);
    default: throw Errors.notFound("Report");
  }
});
