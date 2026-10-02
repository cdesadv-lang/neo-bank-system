/**
 * End-of-Day batch runner (cron / manual).
 *   npm run eod                 → runs EOD for today's business date (Africa/Cairo)
 *   npm run eod -- 2026-10-01   → runs EOD for a specific date
 * Steps (see src/server/services/eod.ts): deposit interest accrual (+ month-end capitalization,
 * term-deposit maturities), loan auto-collection / DPD / penalties / NPL classification,
 * release of expired card holds, monthly maintenance fees, dormancy, balance snapshots and
 * GL ↔ sub-ledger reconciliation. A business date can only complete once.
 */
import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/dates";
import { runEod } from "@/server/services/eod";

async function main() {
  const date = process.argv[2] ?? todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Usage: npm run eod -- YYYY-MM-DD");
  const summary = await runEod(date, { actor: { type: "SYSTEM", name: "eod-cron" } });
  console.log(JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("EOD failed:", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
