import { describe, it, expect, beforeAll } from "vitest";
import { prisma, withTx } from "@/lib/db";
import { addDays, dateOnly, todayStr } from "@/lib/dates";
import { computeFee } from "@/server/services/fees";
import { cashDeposit } from "@/server/services/teller";
import { executeTransfer } from "@/server/services/transfers";
import { openCase } from "@/server/services/aml";
import { openTermDepositTx, processMaturities } from "@/server/services/deposits";
import { balanceSheet, trialBalance, reconcile, incomeStatement } from "@/server/services/reports";
import { resetDb, makeBranch, makeCustomer, makeAccount, fund, makeStaff, principal, actorOf, makeTill, fundTill } from "./helpers";

describe("fees engine, AML rules & cases, term-deposit maturity, financial reports", () => {
  let branchId: string;
  beforeAll(async () => {
    await resetDb();
    branchId = (await makeBranch()).id;
  });

  it("fee = fixed + bps, bounded by min / max", async () => {
    // EXTERNAL_TRANSFER: 10 bps, min EGP 5.00, max EGP 50.00
    expect((await computeFee(prisma, "EXTERNAL_TRANSFER", 100_000n, "EGP")).fee).toBe(500n); // 1.00 → min 5.00
    expect((await computeFee(prisma, "EXTERNAL_TRANSFER", 3_000_000n, "EGP")).fee).toBe(3_000n); // 30.00
    expect((await computeFee(prisma, "EXTERNAL_TRANSFER", 100_000_000n, "EGP")).fee).toBe(5_000n); // 1,000 → max 50.00
    expect((await computeFee(prisma, "CARD_ISSUANCE", 0n, "EGP")).fee).toBe(2_500n); // fixed
    expect((await computeFee(prisma, "NO_SUCH_EVENT", 1_000n, "EGP")).fee).toBe(0n);
  });

  it("large cash deposit raises a CTR alert inside the posting transaction; compliance opens a case", async () => {
    const teller = principal(await makeStaff("TELLER", branchId));
    const till = await makeTill(branchId, "TELLER", teller.id);
    await fundTill(till.id, 100_000_000n);
    const c = await makeCustomer(branchId);
    const acc = await makeAccount(c.id, branchId);
    await cashDeposit(teller, actorOf(teller), { accountId: acc.id, amount: "600000.00", idempotencyKey: "ctr-test-0001" });
    const alerts = await prisma.amlAlert.findMany({ where: { customerId: c.id }, include: { rule: true } });
    expect(alerts.map((a) => a.rule.code)).toContain("CASH_CTR");
    const officer = principal(await makeStaff("COMPLIANCE_OFFICER", null));
    const kase = await openCase(officer, actorOf(officer), { alertIds: alerts.map((a) => a.id), note: "Source of funds requested" });
    expect(kase.status).toBe("INVESTIGATING");
    expect((await prisma.amlAlert.findMany({ where: { caseId: kase.id } })).every((a) => a.status === "ESCALATED")).toBe(true);
    // a teller cannot manage AML
    await expect(openCase(teller, actorOf(teller), { alertIds: [alerts[0].id] })).rejects.toMatchObject({ status: 403 });
  });

  it("movement by a HIGH-risk customer above threshold raises an alert; small ones do not", async () => {
    const hi = await makeCustomer(branchId, { risk: "HIGH" });
    const a = await makeAccount(hi.id, branchId);
    const other = await makeAccount((await makeCustomer(branchId)).id, branchId);
    await fund(a.id, 50_000_000n);
    const sys = { kind: "SYSTEM" as const, actor: { type: "SYSTEM" as const, name: "test" } };
    await executeTransfer(sys, { fromAccountId: a.id, toAccountNumber: other.accountNumber, amount: "50.00", idempotencyKey: "hr-small-001" });
    expect(await prisma.amlAlert.count({ where: { customerId: hi.id } })).toBe(0);
    await executeTransfer(sys, { fromAccountId: a.id, toAccountNumber: other.accountNumber, amount: "150000.00", idempotencyKey: "hr-large-001" });
    const al = await prisma.amlAlert.findMany({ where: { customerId: hi.id }, include: { rule: true } });
    expect(al.map((x) => x.rule.code)).toContain("HIGH_RISK");
  });

  it("term deposit: placement debits source, maturity pays principal + interest back and closes the TD", async () => {
    const c = await makeCustomer(branchId);
    const src = await makeAccount(c.id, branchId);
    await fund(src.id, 20_000_000n); // 200,000.00
    const start = addDays(dateOnly(todayStr()), -95);
    const { td } = await withTx((tx) => openTermDepositTx(tx, { sourceAccountId: src.id, amount: "100000.00", termMonths: 3, interestPayout: "CAPITALIZE", idempotencyKey: "td-mat-0001" }, { customerId: c.id, channel: "BRANCH", postedAt: start }));
    expect((await prisma.account.findUniqueOrThrow({ where: { id: src.id } })).balance).toBe(10_000_000n);
    // simulate accrued interest to be capitalized at maturity
    await prisma.account.update({ where: { id: td!.accountId }, data: { accrualPosted: 0n } });
    const n = await processMaturities(td!.maturityDate);
    expect(n).toBe(1);
    const after = await prisma.termDeposit.findUniqueOrThrow({ where: { id: td!.id }, include: { account: true } });
    expect(after.status).toBe("MATURED");
    expect(after.account.status).toBe("CLOSED");
    expect(after.account.balance).toBe(0n);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: src.id } })).balance).toBe(20_000_000n);
    // replay is a no-op
    expect(await processMaturities(td!.maturityDate)).toBe(0);
  });

  it("trial balance balances, balance sheet balances (A = L + E + current earnings), GL ↔ sub-ledgers reconcile", async () => {
    const tb = await trialBalance();
    for (const t of Object.values(tb.totals)) expect(t.debit).toBe(t.credit);
    const bs = await balanceSheet("EGP");
    expect(bs.totals.balanced).toBe(true);
    const is = await incomeStatement("EGP", new Date("2000-01-01"), new Date());
    expect(is.netIncome).toBe(bs.totals.currentEarnings);
    const rec = await reconcile();
    expect(rec.breaks).toEqual([]);
    expect(rec.ok).toBe(true);
  });
});
