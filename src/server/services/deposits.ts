import { z } from "zod";
import Decimal from "decimal.js";
import type { Currency } from "@prisma/client";
import { prisma, Tx, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { dailyInterest } from "@/lib/amortization";
import { addMonths, dateOnly, isLastDayOfMonth, todayStr, toDateStr } from "@/lib/dates";
import { floorMinor, toMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal } from "@/server/ledger";
import { assertBranchAccess, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { createAccountRow } from "./accounts";
import { notify } from "./notify";

/** Term-deposit rate card (annual bps) by currency and term in months. */
export const TD_RATES: Record<Currency, Record<number, number>> = {
  EGP: { 3: 1900, 6: 1950, 12: 2000, 24: 1850, 36: 1750 },
  USD: { 3: 350, 6: 400, 12: 450, 24: 450, 36: 425 },
  EUR: { 3: 200, 6: 250, 12: 300, 24: 300, 36: 275 },
  SAR: { 3: 300, 6: 350, 12: 400, 24: 400, 36: 375 },
};
export const TD_MIN: Record<Currency, bigint> = { EGP: 500_000n, USD: 50_000n, EUR: 50_000n, SAR: 100_000n };

export const tdInput = z.object({
  sourceAccountId: z.string(),
  amount: z.string(),
  termMonths: z.coerce.number().int(),
  interestPayout: z.enum(["CAPITALIZE", "PAYOUT"]).default("CAPITALIZE"),
  idempotencyKey: z.string().min(8),
});

export async function openTermDepositTx(tx: Tx, input: z.infer<typeof tdInput>, meta: { customerId: string; staffId?: string; channel: "BRANCH" | "PORTAL" | "SYSTEM"; postedAt?: Date }) {
  const src = await tx.account.findUnique({ where: { id: input.sourceAccountId } });
  if (!src || src.customerId !== meta.customerId) throw Errors.notFound("Source account");
  if (src.type === "TERM_DEPOSIT") throw Errors.validation("Source must be a current or savings account");
  const rate = TD_RATES[src.currency][input.termMonths];
  if (!rate) throw Errors.validation(`Unsupported term ${input.termMonths} months`);
  const amount = toMinor(input.amount);
  if (amount < TD_MIN[src.currency]) throw Errors.validation("Amount below the minimum term deposit");
  const key = `td-open:${meta.customerId}:${input.idempotencyKey}`;
  const prior = await tx.journalEntry.findUnique({ where: { idempotencyKey: key } });
  if (prior) {
    const td = await tx.termDeposit.findFirst({ where: { account: { lines: { some: { entryId: prior.id } } } } });
    return { td, replayed: true };
  }
  const start = dateOnly(todayStr(meta.postedAt));
  const acc = await createAccountRow(tx, { customerId: meta.customerId, type: "TERM_DEPOSIT", currency: src.currency, interestRateBps: rate, openedById: meta.staffId, forceStatus: "ACTIVE", openedAt: meta.postedAt, nickname: `TD ${input.termMonths}M` });
  await postJournal(tx, {
    idempotencyKey: key, type: "TD_OPEN", currency: src.currency, channel: meta.channel, branchId: src.branchId, staffId: meta.staffId,
    customerId: meta.channel === "PORTAL" ? meta.customerId : null, description: `Term deposit ${input.termMonths}M @ ${rate / 100}%`, postedAt: meta.postedAt,
    lines: [{ accountId: src.id, debit: amount, narrative: `Placement to TD ${acc.accountNumber}` }, { accountId: acc.id, credit: amount, narrative: "TD placement" }],
  });
  const td = await tx.termDeposit.create({
    data: {
      accountId: acc.id, sourceAccountId: src.id, payoutAccountId: src.id, principal: amount, rateBps: rate, termMonths: input.termMonths,
      startDate: start, maturityDate: addMonths(start, input.termMonths), interestPayout: input.interestPayout,
    },
  });
  await tx.account.update({ where: { id: acc.id }, data: { lastAccrualDate: start } });
  await notify(tx, meta.customerId, { titleAr: "تم ربط وديعة", titleEn: "Term deposit opened", bodyAr: `وديعة ${input.termMonths} شهر بعائد ${rate / 100}%`, bodyEn: `${input.termMonths}-month deposit at ${rate / 100}%`, createdAt: meta.postedAt });
  return { td, replayed: false };
}

export async function openTermDeposit(staff: StaffPrincipal, actor: Actor, customerId: string, raw: unknown) {
  requirePerm(staff, "deposit.open");
  const input = tdInput.parse(raw);
  const c = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  if (c.kycStatus !== "APPROVED") throw new AppError("KYC_REQUIRED", 422, "KYC must be approved");
  return withTx(async (tx) => {
    const r = await openTermDepositTx(tx, input, { customerId, staffId: staff.id, channel: "BRANCH" });
    if (!r.replayed) await audit(actor, "TD_OPENED", { type: "TermDeposit", id: r.td?.id }, undefined, r.td, tx);
    return r;
  });
}

/**
 * Daily interest accrual (Actual/365) for savings and term deposits, for one business date.
 *  - each account accrues balance × rate / 365 into accruedInterest (8 dp, minor units)
 *  - the whole-minor-unit delta is booked per currency: Dr Interest Expense / Cr Accrued Interest Payable
 *  - month-end (or TD maturity): capitalize floor(accrued) — Dr Interest Payable / Cr customer (or payout) account
 * Idempotent per date via lastAccrualDate and journal idempotency keys.
 */
export async function accrueInterestForDate(date: Date, postedAt?: Date) {
  const ds = toDateStr(date);
  const accounts = await prisma.account.findMany({
    where: { type: { in: ["SAVINGS", "TERM_DEPOSIT"] }, interestRateBps: { gt: 0 }, status: { in: ["ACTIVE", "DORMANT", "FROZEN"] } },
    include: { termDeposit: true },
  });
  const deltaByCcy = new Map<Currency, bigint>();
  let accrued = 0;
  await withTx(async (tx) => {
    for (const a of accounts) {
      if (a.lastAccrualDate && a.lastAccrualDate >= date) continue;
      if (a.termDeposit && a.termDeposit.status !== "ACTIVE") continue;
      if (a.openedAt > new Date(date.getTime() + 86_400_000)) continue;
      const inc = dailyInterest(a.balance, a.interestRateBps);
      const newAccrued = new Decimal(a.accruedInterest.toString()).plus(inc);
      const shouldPost = floorMinor(newAccrued);
      const delta = shouldPost - a.accrualPosted;
      await tx.account.update({ where: { id: a.id }, data: { accruedInterest: newAccrued.toFixed(8), accrualPosted: shouldPost, lastAccrualDate: date } });
      if (delta > 0n) deltaByCcy.set(a.currency, (deltaByCcy.get(a.currency) ?? 0n) + delta);
      accrued++;
    }
    for (const [ccy, amt] of deltaByCcy) {
      await postJournal(tx, {
        idempotencyKey: `accrual:${ds}:${ccy}`, type: "INTEREST_ACCRUAL", currency: ccy, channel: "SYSTEM", skipAml: true, valueDate: ds, postedAt,
        description: `Deposit interest accrual ${ds}`,
        lines: [{ glCode: GL.DEPOSIT_INTEREST_EXPENSE, debit: amt }, { glCode: GL.INTEREST_PAYABLE, credit: amt }],
      });
    }
  }, { timeout: 120_000 });
  let capitalized = 0;
  if (isLastDayOfMonth(date)) capitalized = await capitalizeInterest(date, postedAt);
  const matured = await processMaturities(date, postedAt);
  return { accrued, posted: Object.fromEntries([...deltaByCcy].map(([k, v]) => [k, v.toString()])), capitalized, matured };
}

async function capitalizeOne(tx: Tx, accountId: string, ds: string, postedAt?: Date): Promise<bigint> {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
  const a = await tx.account.findUniqueOrThrow({ where: { id: accountId }, include: { termDeposit: true } });
  const amt = a.accrualPosted;
  if (amt <= 0n) return 0n;
  const target = a.termDeposit && a.termDeposit.interestPayout === "PAYOUT" ? a.termDeposit.payoutAccountId : a.id;
  await postJournal(tx, {
    idempotencyKey: `capitalize:${a.id}:${ds}`, type: "INTEREST_CAPITALIZATION", currency: a.currency, channel: "SYSTEM", skipAml: true,
    overrideStatus: true, valueDate: ds, postedAt, branchId: a.branchId, description: `Interest ${ds} on ${a.accountNumber}`,
    lines: [{ glCode: GL.INTEREST_PAYABLE, debit: amt }, { accountId: target, credit: amt, narrative: `Interest credit (${a.interestRateBps / 100}% p.a.)` }],
  });
  const remaining = new Decimal(a.accruedInterest.toString()).minus(amt.toString());
  await tx.account.update({ where: { id: a.id }, data: { accruedInterest: remaining.toFixed(8), accrualPosted: 0n } });
  return amt;
}

export async function capitalizeInterest(date: Date, postedAt?: Date) {
  const ds = toDateStr(date);
  const accounts = await prisma.account.findMany({ where: { type: { in: ["SAVINGS", "TERM_DEPOSIT"] }, accrualPosted: { gt: 0n }, status: { not: "CLOSED" } }, select: { id: true } });
  let n = 0;
  for (const a of accounts) {
    await withTx(async (tx) => {
      const amt = await capitalizeOne(tx, a.id, ds, postedAt);
      if (amt > 0n) n++;
    });
  }
  return n;
}

/** Maturity: capitalize remaining interest, pay the TD balance to the payout account, close the TD account. */
export async function processMaturities(date: Date, postedAt?: Date) {
  const ds = toDateStr(date);
  const due = await prisma.termDeposit.findMany({ where: { status: "ACTIVE", maturityDate: { lte: date } } });
  for (const td of due) {
    await withTx(async (tx) => {
      await capitalizeOne(tx, td.accountId, ds, postedAt);
      const acc = await tx.account.findUniqueOrThrow({ where: { id: td.accountId } });
      if (acc.balance > 0n) {
        await postJournal(tx, {
          idempotencyKey: `td-maturity:${td.id}`, type: "TD_MATURITY", currency: acc.currency, channel: "SYSTEM", skipAml: true, overrideStatus: true,
          valueDate: ds, postedAt, branchId: acc.branchId, description: `Maturity of term deposit ${acc.accountNumber}`,
          lines: [{ accountId: acc.id, debit: acc.balance }, { accountId: td.payoutAccountId, credit: acc.balance, narrative: `TD ${acc.accountNumber} matured` }],
        });
      }
      await tx.termDeposit.update({ where: { id: td.id }, data: { status: "MATURED" } });
      await tx.account.update({ where: { id: acc.id }, data: { status: "CLOSED", closedAt: postedAt ?? new Date() } });
      await notify(tx, acc.customerId, { titleAr: "استحقاق وديعة", titleEn: "Deposit matured", bodyAr: `تم استحقاق الوديعة ${acc.accountNumber}`, bodyEn: `Term deposit ${acc.accountNumber} matured and was paid out`, createdAt: postedAt });
    });
  }
  return due.length;
}
