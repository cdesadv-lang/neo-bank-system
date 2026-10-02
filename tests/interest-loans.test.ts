import { describe, it, expect, beforeAll } from "vitest";
import Decimal from "decimal.js";
import { prisma } from "@/lib/db";
import { amortize, dailyInterest } from "@/lib/amortization";
import { dateOnly, addDays } from "@/lib/dates";
import { accrueInterestForDate } from "@/server/services/deposits";
import { applyLoan, loanDecision, disburseLoan, repayLoan, processLoansEod, classify } from "@/server/services/loans";
import { reconcile } from "@/server/services/reports";
import { resetDb, makeBranch, makeCustomer, makeAccount, fund, makeStaff, principal, actorOf, ledgerBalanceOfAccount } from "./helpers";

describe("amortization math", () => {
  it("computes the textbook annuity payment and Σprincipal == P", () => {
    // EGP 100,000.00 at 24% p.a. over 12 months: r = 2%/month → A = 9,455.96
    const s = amortize(10_000_000n, 2400, 12, dateOnly("2026-01-31"));
    expect(s).toHaveLength(12);
    expect(s[0].payment).toBe(945_596n);
    expect(s[0].interest).toBe(200_000n); // 2% of 100,000.00
    expect(s.reduce((a, i) => a + i.principal, 0n)).toBe(10_000_000n);
    expect(s[11].balance).toBe(0n);
    // all but the last installment are level
    for (const i of s.slice(0, 11)) expect(i.payment).toBe(945_596n);
    expect(Math.abs(Number(s[11].payment - 945_596n))).toBeLessThan(20);
    // month-end roll: Jan 31 → Feb 28
    expect(s[1].dueDate.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("handles zero-rate loans", () => {
    const s = amortize(1_000_00n, 0, 3, dateOnly("2026-01-01"));
    expect(s.map((x) => x.principal)).toEqual([33_333n, 33_333n, 33_334n]);
    expect(s.every((x) => x.interest === 0n)).toBe(true);
  });

  it("total interest matches closed-form within rounding", () => {
    const P = 50_000_000n, n = 36, bps = 2100;
    const s = amortize(P, bps, n, dateOnly("2026-03-15"));
    const r = new Decimal(bps).div(120000);
    const A = new Decimal(P.toString()).mul(r).div(new Decimal(1).minus(r.plus(1).pow(-n)));
    const totalInterest = A.mul(n).minus(P.toString());
    const actual = s.reduce((a, i) => a + i.interest, 0n);
    expect(Math.abs(Number(actual) - totalInterest.toNumber())).toBeLessThan(n * 2);
  });
});

describe("deposit interest accrual", () => {
  let accId: string;
  beforeAll(async () => {
    await resetDb();
    const b = await makeBranch();
    const c = await makeCustomer(b.id);
    accId = (await makeAccount(c.id, b.id, { type: "SAVINGS", rateBps: 1500 })).id;
    await fund(accId, 100_000_000n); // EGP 1,000,000.00
    await prisma.account.update({ where: { id: accId }, data: { openedAt: new Date("2026-01-01T00:00:00Z") } });
  });

  it("daily accrual = balance × rate / 365 (Actual/365)", () => {
    const d = dailyInterest(100_000_000n, 1500);
    expect(d.toFixed(6)).toBe("41095.890411"); // EGP 410.958904…/day
  });

  it("accrues daily, books whole-unit GL accrual, and capitalizes on month end", async () => {
    for (let day = 1; day <= 31; day++) {
      await accrueInterestForDate(dateOnly(`2026-01-${String(day).padStart(2, "0")}`));
    }
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: accId } });
    // 31 days × 41095.890410958… = 1,273,972.6027… minor → capitalized floor = 1,273,972 (EGP 12,739.72)
    expect(acc.balance).toBe(100_000_000n + 1_273_972n);
    expect(new Decimal(acc.accruedInterest.toString()).toFixed(4)).toBe("0.6027"); // remainder carried
    expect(acc.accrualPosted).toBe(0n);
    expect(acc.balance).toBe(await ledgerBalanceOfAccount(accId));
    // payable GL nets to zero after capitalization
    const payable = await prisma.journalLine.aggregate({ where: { glAccount: { code: "2200" } }, _sum: { debit: true, credit: true } });
    expect(payable._sum.credit).toBe(payable._sum.debit);
    const expense = await prisma.journalLine.aggregate({ where: { glAccount: { code: "5010" } }, _sum: { debit: true } });
    expect(expense._sum.debit).toBe(1_273_972n);
  });

  it("is idempotent per business date", async () => {
    const before = await prisma.journalEntry.count();
    await accrueInterestForDate(dateOnly("2026-01-31"));
    expect(await prisma.journalEntry.count()).toBe(before);
    expect((await reconcile()).breaks).toEqual([]);
  });
});

describe("loan lifecycle", () => {
  it("applies → recommends → approves (four eyes) → disburses → repays → penalties/NPL aging", async () => {
    await resetDb();
    const b = await makeBranch();
    const c = await makeCustomer(b.id);
    const acc = await makeAccount(c.id, b.id);
    const officer = principal(await makeStaff("CREDIT_OFFICER", b.id));
    const manager = principal(await makeStaff("CREDIT_MANAGER", null));
    const teller = principal(await makeStaff("TELLER", b.id));
    const product = await prisma.loanProduct.findUniqueOrThrow({ where: { code: "PERSONAL" } });

    const loan = await applyLoan(officer, actorOf(officer), { customerId: c.id, productId: product.id, amount: "120000.00", termMonths: 12, accountId: acc.id });
    await expect(loanDecision(teller, actorOf(teller), loan.id, { action: "RECOMMEND" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(loanDecision(manager, actorOf(manager), loan.id, { action: "APPROVE" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await loanDecision(officer, actorOf(officer), loan.id, { action: "RECOMMEND" });
    await expect(loanDecision(officer, actorOf(officer), loan.id, { action: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await loanDecision(manager, actorOf(manager), loan.id, { action: "APPROVE" });
    await disburseLoan(manager, actorOf(manager), loan.id);

    const l = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id }, include: { installments: { orderBy: { seq: "asc" } } } });
    expect(l.status).toBe("DISBURSED");
    expect(l.outstandingPrincipal).toBe(12_000_000n);
    expect(l.installments).toHaveLength(12);
    const a = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(a.balance).toBe(12_000_000n - 120_000n); // 1% admin fee

    // repay first installment exactly
    const first = l.installments[0];
    const due = first.principalDue + first.interestDue;
    await repayLoan(teller, actorOf(teller), loan.id, { amount: (Number(due) / 100).toFixed(2), idempotencyKey: "repay-0001" });
    const ins1 = await prisma.loanInstallment.findUniqueOrThrow({ where: { id: first.id } });
    expect(ins1.status).toBe("PAID");
    const l2 = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(l2.outstandingPrincipal).toBe(12_000_000n - first.principalDue);
    const interestIncome = await prisma.journalLine.aggregate({ where: { glAccount: { code: "4010" } }, _sum: { credit: true } });
    expect(interestIncome._sum.credit).toBe(first.interestDue);

    // drain the account so installment 2 cannot be auto-collected, then run EOD 95 days after its due date
    await prisma.$executeRaw`SELECT 1`;
    const drain = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    const { withTx } = await import("@/lib/db");
    const { postJournal } = await import("@/server/ledger");
    await withTx((tx) => postJournal(tx, { idempotencyKey: "drain-1", type: "MANUAL", description: "drain", currency: "EGP", lines: [{ accountId: acc.id, debit: drain.balance }, { glCode: "1100", credit: drain.balance }] }));
    const ins2 = l.installments[1];
    await processLoansEod(addDays(ins2.dueDate, 95));
    const l3 = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(l3.daysPastDue).toBe(95);
    expect(l3.classification).toBe("NPL_90_PLUS");
    const ins2b = await prisma.loanInstallment.findUniqueOrThrow({ where: { id: ins2.id } });
    // penalty = overdue × 36% / 365 for one day
    const expectedPen = new Decimal((ins2.principalDue + ins2.interestDue).toString()).mul(3600).div(10000).div(365).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    expect(ins2b.penaltyDue.toString()).toBe(expectedPen.toFixed(0));
    expect(classify(0)).toBe("CURRENT");
    expect(classify(45)).toBe("DPD_31_60");
    expect((await reconcile()).breaks).toEqual([]);
  });
});
