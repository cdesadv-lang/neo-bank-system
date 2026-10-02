import type { Currency } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toEgpEquivalent } from "@/lib/fx";
import { addDays, dateOnly, todayStr } from "@/lib/dates";
import { GL, isDebitNormal } from "@/server/gl";
import { branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";

type TbRow = { code: string; nameAr: string; nameEn: string; type: string; currency: string; debit: bigint; credit: bigint; balance: bigint };

/** Trial balance from journal lines (the ledger is the single source of truth). */
export async function trialBalance(asOf?: Date): Promise<{ rows: TbRow[]; totals: Record<string, { debit: bigint; credit: bigint; balanced: boolean }> }> {
  const until = asOf ?? new Date();
  const rows = await prisma.$queryRaw<{ code: string; nameAr: string; nameEn: string; type: string; currency: string; debit: bigint; credit: bigint }[]>`
    SELECT g.code, g."nameAr", g."nameEn", g.type::text AS type, l.currency::text AS currency,
           COALESCE(SUM(l.debit),0)::bigint AS debit, COALESCE(SUM(l.credit),0)::bigint AS credit
    FROM "JournalLine" l JOIN "GlAccount" g ON g.id = l."glAccountId" JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."postedAt" <= ${until}
    GROUP BY g.code, g."nameAr", g."nameEn", g.type, l.currency ORDER BY l.currency, g.code`;
  const out: TbRow[] = rows.map((r) => {
    const debit = BigInt(r.debit), credit = BigInt(r.credit);
    return { ...r, debit, credit, balance: isDebitNormal(r.type as never) ? debit - credit : credit - debit };
  });
  const totals: Record<string, { debit: bigint; credit: bigint; balanced: boolean }> = {};
  for (const r of out) {
    const t = (totals[r.currency] ??= { debit: 0n, credit: 0n, balanced: true });
    t.debit += r.debit;
    t.credit += r.credit;
  }
  for (const t of Object.values(totals)) t.balanced = t.debit === t.credit;
  return { rows: out, totals };
}

export async function balanceSheet(currency: Currency, asOf?: Date) {
  const tb = await trialBalance(asOf);
  const rows = tb.rows.filter((r) => r.currency === currency);
  const sum = (t: string) => rows.filter((r) => r.type === t).reduce((s, r) => s + r.balance, 0n);
  const income = sum("INCOME"), expense = sum("EXPENSE");
  const assets = sum("ASSET"), liabilities = sum("LIABILITY"), equity = sum("EQUITY");
  const earnings = income - expense;
  return {
    currency, assets: rows.filter((r) => r.type === "ASSET"), liabilities: rows.filter((r) => r.type === "LIABILITY"), equity: rows.filter((r) => r.type === "EQUITY"),
    totals: { assets, liabilities, equity, currentEarnings: earnings, liabilitiesAndEquity: liabilities + equity + earnings, balanced: assets === liabilities + equity + earnings },
  };
}

export async function incomeStatement(currency: Currency, from: Date, to: Date) {
  const rows = await prisma.$queryRaw<{ code: string; nameAr: string; nameEn: string; type: string; debit: bigint; credit: bigint }[]>`
    SELECT g.code, g."nameAr", g."nameEn", g.type::text AS type, COALESCE(SUM(l.debit),0)::bigint AS debit, COALESCE(SUM(l.credit),0)::bigint AS credit
    FROM "JournalLine" l JOIN "GlAccount" g ON g.id = l."glAccountId" JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE l.currency::text = ${currency} AND g.type IN ('INCOME','EXPENSE') AND e."postedAt" >= ${from} AND e."postedAt" <= ${to}
    GROUP BY g.code, g."nameAr", g."nameEn", g.type ORDER BY g.code`;
  const items = rows.map((r) => ({ ...r, amount: r.type === "INCOME" ? BigInt(r.credit) - BigInt(r.debit) : BigInt(r.debit) - BigInt(r.credit) }));
  const income = items.filter((i) => i.type === "INCOME").reduce((s, i) => s + i.amount, 0n);
  const expense = items.filter((i) => i.type === "EXPENSE").reduce((s, i) => s + i.amount, 0n);
  return { currency, from, to, items, income, expense, netIncome: income - expense };
}

export async function glDetail(code: string, currency: Currency, from: Date, to: Date) {
  const gl = await prisma.glAccount.findUniqueOrThrow({ where: { code } });
  const lines = await prisma.journalLine.findMany({
    where: { glAccountId: gl.id, currency, entry: { postedAt: { gte: from, lte: to } } },
    include: { entry: true, account: { select: { accountNumber: true } }, till: { select: { code: true } }, loan: { select: { loanNumber: true } } },
    orderBy: { entry: { postedAt: "asc" } },
    take: 2000,
  });
  return { gl, lines };
}

/** Sub-ledger ↔ GL reconciliation + per-account ledger-sum check. Empty `breaks` means books reconcile. */
export async function reconcile() {
  const breaks: string[] = [];
  const glBal = await prisma.$queryRaw<{ code: string; currency: string; dr: bigint; cr: bigint }[]>`
    SELECT g.code, l.currency::text AS currency, SUM(l.debit)::bigint AS dr, SUM(l.credit)::bigint AS cr
    FROM "JournalLine" l JOIN "GlAccount" g ON g.id = l."glAccountId" GROUP BY g.code, l.currency`;
  const get = (code: string, ccy: string) => {
    const r = glBal.find((x) => x.code === code && x.currency === ccy);
    return r ? { dr: BigInt(r.dr), cr: BigInt(r.cr) } : { dr: 0n, cr: 0n };
  };
  const accSums = await prisma.account.groupBy({ by: ["type", "currency"], _sum: { balance: true } });
  for (const s of accSums) {
    const code = s.type === "CURRENT" ? GL.CURRENT_ACCOUNTS : s.type === "SAVINGS" ? GL.SAVINGS_ACCOUNTS : GL.TERM_DEPOSITS;
    const g = get(code, s.currency);
    if (g.cr - g.dr !== (s._sum.balance ?? 0n)) breaks.push(`GL ${code} ${s.currency}: GL ${g.cr - g.dr} vs sub-ledger ${s._sum.balance}`);
  }
  const tillSums = await prisma.till.groupBy({ by: ["kind", "currency"], _sum: { balance: true } });
  for (const s of tillSums) {
    const g = get(s.kind === "VAULT" ? GL.CASH_VAULT : GL.CASH_TILLS, s.currency);
    if (g.dr - g.cr !== (s._sum.balance ?? 0n)) breaks.push(`Cash GL ${s.kind} ${s.currency}: ${g.dr - g.cr} vs tills ${s._sum.balance}`);
  }
  const loanSums = await prisma.loan.groupBy({ by: ["currency"], _sum: { outstandingPrincipal: true } });
  for (const s of loanSums) {
    const g = get(GL.LOANS, s.currency);
    if (g.dr - g.cr !== (s._sum.outstandingPrincipal ?? 0n)) breaks.push(`Loans GL ${s.currency}: ${g.dr - g.cr} vs loans ${s._sum.outstandingPrincipal}`);
  }
  const accountBreaks = await prisma.$queryRaw<{ accountNumber: string; balance: bigint; ledger: bigint }[]>`
    SELECT a."accountNumber", a.balance, COALESCE(SUM(l.credit - l.debit),0)::bigint AS ledger
    FROM "Account" a LEFT JOIN "JournalLine" l ON l."accountId" = a.id
    GROUP BY a.id HAVING a.balance <> COALESCE(SUM(l.credit - l.debit),0)`;
  for (const b of accountBreaks) breaks.push(`Account ${b.accountNumber}: balance ${b.balance} vs ledger ${b.ledger}`);
  const tillBreaks = await prisma.$queryRaw<{ code: string }[]>`
    SELECT t.code FROM "Till" t LEFT JOIN "JournalLine" l ON l."tillId" = t.id GROUP BY t.id HAVING t.balance <> COALESCE(SUM(l.debit - l.credit),0)`;
  for (const b of tillBreaks) breaks.push(`Till ${b.code} differs from ledger`);
  const loanBreaks = await prisma.$queryRaw<{ loanNumber: string }[]>`
    SELECT n."loanNumber" FROM "Loan" n LEFT JOIN "JournalLine" l ON l."loanId" = n.id GROUP BY n.id HAVING n."outstandingPrincipal" <> COALESCE(SUM(l.debit - l.credit),0)`;
  for (const b of loanBreaks) breaks.push(`Loan ${b.loanNumber} differs from ledger`);
  const tb = await trialBalance();
  for (const [ccy, t] of Object.entries(tb.totals)) if (!t.balanced) breaks.push(`Trial balance ${ccy} not balanced: ${t.debit} vs ${t.credit}`);
  return { ok: breaks.length === 0, breaks, trialBalanceTotals: tb.totals };
}

export async function loanPortfolio(staff: StaffPrincipal) {
  requirePerm(staff, "report.read");
  const loans = await prisma.loan.findMany({ where: { ...branchWhere(staff), status: { in: ["DISBURSED", "CLOSED", "APPROVED", "APPLIED", "RECOMMENDED"] } }, include: { product: true, customer: true, branch: true } });
  const byClass: Record<string, { count: number; outstanding: bigint }> = {};
  const byProduct: Record<string, { count: number; outstanding: bigint }> = {};
  let outstanding = 0n, npl = 0n;
  for (const l of loans.filter((x) => x.status === "DISBURSED")) {
    (byClass[l.classification] ??= { count: 0, outstanding: 0n }).count++;
    byClass[l.classification].outstanding += l.outstandingPrincipal;
    (byProduct[l.product.nameEn] ??= { count: 0, outstanding: 0n }).count++;
    byProduct[l.product.nameEn].outstanding += l.outstandingPrincipal;
    outstanding += l.outstandingPrincipal;
    if (l.classification === "NPL_90_PLUS") npl += l.outstandingPrincipal;
  }
  const nplRatioBps = outstanding > 0n ? Number((npl * 10000n) / outstanding) : 0;
  return { loans, byClass, byProduct, outstanding, npl, nplRatioBps };
}

export async function depositsReport(staff: StaffPrincipal) {
  requirePerm(staff, "report.read");
  const sums = await prisma.account.groupBy({ by: ["type", "currency"], where: { ...branchWhere(staff), status: { not: "CLOSED" } }, _sum: { balance: true }, _count: true });
  const tds = await prisma.termDeposit.findMany({ where: { status: "ACTIVE", account: { ...branchWhere(staff) } }, include: { account: { include: { customer: true } } }, orderBy: { maturityDate: "asc" } });
  return { sums, tds };
}

export async function tellerCash(staff: StaffPrincipal) {
  requirePerm(staff, "report.read");
  const tills = await prisma.till.findMany({ where: { ...branchWhere(staff) }, include: { branch: true, balancings: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { code: "asc" } });
  return { tills };
}

export async function dailyTransactions(staff: StaffPrincipal, dateStr?: string) {
  requirePerm(staff, "report.read");
  const d = dateOnly(dateStr ?? todayStr());
  const entries = await prisma.journalEntry.findMany({
    where: { valueDate: d, ...(branchWhere(staff).branchId ? { branchId: branchWhere(staff).branchId } : {}) },
    include: { lines: true },
    orderBy: { postedAt: "asc" },
  });
  const byType: Record<string, { count: number; amount: Record<string, bigint> }> = {};
  for (const e of entries) {
    const amt = e.lines.reduce((s, l) => s + l.debit, 0n);
    const t = (byType[e.type] ??= { count: 0, amount: {} });
    t.count++;
    t.amount[e.currency] = (t.amount[e.currency] ?? 0n) + amt;
  }
  return { date: d, entries, byType };
}

export async function amlReport(staff: StaffPrincipal) {
  requirePerm(staff, "aml.read");
  const byRule = await prisma.amlAlert.groupBy({ by: ["ruleId", "status"], _count: true });
  const rules = await prisma.amlRule.findMany();
  return { byRule: byRule.map((r) => ({ ...r, rule: rules.find((x) => x.id === r.ruleId) })), rules };
}

export async function dashboard(staff: StaffPrincipal) {
  requirePerm(staff, "dashboard.read");
  const bw = branchWhere(staff);
  const since = addDays(dateOnly(todayStr()), -29);
  const [customers, pendingKyc, accounts, depositSums, loans, approvals, openAlerts, openTickets, daily] = await Promise.all([
    prisma.customer.count({ where: bw }),
    prisma.customer.count({ where: { ...bw, kycStatus: "PENDING" } }),
    prisma.account.count({ where: { ...bw, status: { not: "CLOSED" } } }),
    prisma.account.groupBy({ by: ["currency", "type"], where: { ...bw, status: { not: "CLOSED" } }, _sum: { balance: true } }),
    prisma.loan.groupBy({ by: ["classification"], where: { ...bw, status: "DISBURSED" }, _sum: { outstandingPrincipal: true }, _count: true }),
    prisma.approvalRequest.count({ where: { status: "PENDING", ...(bw.branchId ? { branchId: bw.branchId } : {}) } }),
    prisma.amlAlert.count({ where: { status: { in: ["OPEN", "IN_REVIEW"] } } }),
    prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] }, customer: bw } }),
    prisma.$queryRaw<{ d: Date; cnt: bigint; vol: bigint }[]>`
      SELECT e."valueDate" AS d, COUNT(*)::bigint AS cnt, COALESCE(SUM(x.amt),0)::bigint AS vol
      FROM "JournalEntry" e JOIN LATERAL (SELECT SUM(debit) AS amt FROM "JournalLine" WHERE "entryId" = e.id) x ON true
      WHERE e."valueDate" >= ${since} AND e.currency = 'EGP' AND e.type NOT IN ('INTEREST_ACCRUAL')
        AND (${bw.branchId ?? null}::text IS NULL OR e."branchId" = ${bw.branchId ?? null})
      GROUP BY e."valueDate" ORDER BY e."valueDate"`,
  ]);
  const depositsEgpEq = depositSums.reduce((s, r) => s + toEgpEquivalent(r._sum.balance ?? 0n, r.currency), 0n);
  const loanOutstanding = loans.reduce((s, r) => s + (r._sum.outstandingPrincipal ?? 0n), 0n);
  const npl = loans.filter((l) => l.classification === "NPL_90_PLUS").reduce((s, r) => s + (r._sum.outstandingPrincipal ?? 0n), 0n);
  return {
    customers, pendingKyc, accounts, depositsEgpEq, loanOutstanding, nplRatioBps: loanOutstanding > 0n ? Number((npl * 10000n) / loanOutstanding) : 0,
    approvals, openAlerts, openTickets, depositSums, loans, daily: daily.map((d) => ({ date: d.d.toISOString().slice(0, 10), count: Number(d.cnt), volume: BigInt(d.vol) })),
  };
}
