import { prisma, withTx } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addDays, dateOnly, isLastDayOfMonth, toDateStr } from "@/lib/dates";
import { audit, SYSTEM_ACTOR, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal } from "@/server/ledger";
import { accrueInterestForDate } from "./deposits";
import { processLoansEod } from "./loans";
import { computeFee } from "./fees";
import { reconcile } from "./reports";

/**
 * End-of-day batch for a business date. Steps are individually idempotent, so a
 * FAILED run can be safely re-run; a COMPLETED date cannot be run twice.
 */
export async function runEod(dateStr: string, opts: { actor?: Actor; staffId?: string; postedAt?: Date; skipChecks?: boolean } = {}) {
  const date = dateOnly(dateStr);
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const existing = await prisma.eodRun.findUnique({ where: { businessDate: date } });
  if (existing?.status === "COMPLETED") throw new AppError("EOD_ALREADY_RUN", 409, `EOD already completed for ${dateStr}`);
  if (existing?.status === "RUNNING" && Date.now() - existing.startedAt.getTime() < 10 * 60_000) throw new AppError("EOD_RUNNING", 409, "EOD is already running");
  const run = existing
    ? await prisma.eodRun.update({ where: { id: existing.id }, data: { status: "RUNNING", startedAt: new Date(), error: null, runById: opts.staffId } })
    : await prisma.eodRun.create({ data: { businessDate: date, status: "RUNNING", runById: opts.staffId } });
  const postedAt = opts.postedAt;
  try {
    const interest = await accrueInterestForDate(date, postedAt);
    const loans = await processLoansEod(date, postedAt);

    // Monthly maintenance fee on current accounts (month end), only if funds allow.
    let maintenance = 0;
    if (isLastDayOfMonth(date)) {
      const accs = await prisma.account.findMany({ where: { type: "CURRENT", status: "ACTIVE", currency: "EGP" } });
      for (const a of accs) {
        const { fee } = await computeFee(prisma, "MONTHLY_MAINTENANCE", 0n, a.currency);
        if (fee <= 0n || a.balance < fee) continue;
        await withTx(async (tx) => {
          await postJournal(tx, {
            idempotencyKey: `fee-maint:${a.id}:${dateStr.slice(0, 7)}`, type: "FEE", currency: a.currency, channel: "SYSTEM", skipAml: true, postedAt, valueDate: dateStr,
            branchId: a.branchId, description: `Monthly maintenance fee ${dateStr.slice(0, 7)}`,
            lines: [{ accountId: a.id, debit: fee, narrative: "Monthly maintenance fee" }, { glCode: GL.FEE_INCOME, credit: fee }],
          }).catch((e) => { if ((e as { code?: string }).code !== "INSUFFICIENT_FUNDS") throw e; });
        });
        maintenance++;
      }
    }

    // Dormancy: no customer activity for 365 days.
    const cutoff = addDays(date, -365);
    const dormant = await prisma.account.findMany({ where: { status: "ACTIVE", type: { in: ["CURRENT", "SAVINGS"] }, lastActivityAt: { lt: cutoff } }, select: { id: true } });
    if (dormant.length) {
      await prisma.account.updateMany({ where: { id: { in: dormant.map((d) => d.id) } }, data: { status: "DORMANT" } });
      await audit(actor, "ACCOUNTS_MARKED_DORMANT", { type: "Account" }, undefined, { ids: dormant.map((d) => d.id) });
    }

    // Balance snapshots
    const accts = await prisma.account.findMany({ where: { status: { not: "CLOSED" } }, select: { id: true, balance: true } });
    await prisma.balanceSnapshot.createMany({ data: accts.map((a) => ({ accountId: a.id, businessDate: date, balance: a.balance })), skipDuplicates: true });

    const checks = opts.skipChecks ? { ok: true, breaks: [] as string[], trialBalanceTotals: {} } : await reconcile();
    const summary = { date: toDateStr(date), interest, loans, maintenance, dormant: dormant.length, snapshots: accts.length, checks };
    const status = checks.ok ? "COMPLETED" : "FAILED";
    await prisma.eodRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), summary: JSON.parse(JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), error: checks.ok ? null : checks.breaks.join("; ") } });
    await audit(actor, "EOD_RUN", { type: "EodRun", id: run.id }, undefined, { status, date: dateStr });
    if (!checks.ok) throw new AppError("EOD_CHECK_FAILED", 500, `Reconciliation breaks: ${checks.breaks.join("; ")}`);
    return summary;
  } catch (e) {
    await prisma.eodRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) } }).catch(() => {});
    throw e;
  }
}
