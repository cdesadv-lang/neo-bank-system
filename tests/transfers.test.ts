import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/db";
import { executeTransfer } from "@/server/services/transfers";
import { submitBatch, settleBatch } from "@/server/services/transfers";
import { reconcile } from "@/server/services/reports";
import { makeIban } from "@/lib/iban";
import { resetDb, makeBranch, makeCustomer, makeAccount, fund, ledgerBalanceOfAccount, makeStaff, principal, actorOf } from "./helpers";
import type { Actor } from "@/server/audit";

const sys: Actor = { type: "SYSTEM", name: "test" };

describe("transfers", () => {
  let branchId: string, custA: string, custB: string;
  let a1: { id: string; accountNumber: string }, b1: { id: string; accountNumber: string };

  beforeAll(async () => {
    await resetDb();
    branchId = (await makeBranch("0101")).id;
    custA = (await makeCustomer(branchId)).id;
    custB = (await makeCustomer(branchId)).id;
    a1 = await makeAccount(custA, branchId);
    b1 = await makeAccount(custB, branchId);
    await fund(a1.id, 100_000n); // EGP 1,000.00
  });

  it("moves money atomically between accounts and keeps the ledger balanced", async () => {
    const r = await executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: b1.accountNumber, amount: "100.00", idempotencyKey: "atomic-0001" });
    expect(r.transfer.status).toBe("COMPLETED");
    const [x, y] = await Promise.all([prisma.account.findUniqueOrThrow({ where: { id: a1.id } }), prisma.account.findUniqueOrThrow({ where: { id: b1.id } })]);
    expect(x.balance).toBe(90_000n);
    expect(y.balance).toBe(10_000n);
    expect(x.balance).toBe(await ledgerBalanceOfAccount(a1.id));
    expect(y.balance).toBe(await ledgerBalanceOfAccount(b1.id));
  });

  it("rejects insufficient funds without any partial posting", async () => {
    const before = await prisma.journalEntry.count();
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: b1.accountNumber, amount: "5000.00", idempotencyKey: "insuff-0001" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(await prisma.journalEntry.count()).toBe(before);
    expect(await prisma.transfer.count({ where: { reference: { contains: "" }, amount: 500_000n } })).toBe(0);
  });

  it("prevents double spend under 20 concurrent transfers", async () => {
    const src = await makeAccount(custA, branchId);
    const dst = await makeAccount(custB, branchId);
    await fund(src.id, 100_000n); // 1,000.00 → only 10 transfers of 100.00 can succeed
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: src.id, toAccountNumber: dst.accountNumber, amount: "100.00", idempotencyKey: `race-${i}-xxxxxx` }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toBe(10);
    expect(failed.every((f) => (f.reason as { code?: string }).code === "INSUFFICIENT_FUNDS")).toBe(true);
    const s = await prisma.account.findUniqueOrThrow({ where: { id: src.id } });
    const d = await prisma.account.findUniqueOrThrow({ where: { id: dst.id } });
    expect(s.balance).toBe(0n);
    expect(d.balance).toBe(100_000n);
    expect(s.balance).toBe(await ledgerBalanceOfAccount(src.id));
  });

  it("is idempotent: 10 concurrent submissions with the same key create exactly one transfer", async () => {
    const src = await makeAccount(custA, branchId);
    await fund(src.id, 100_000n);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: src.id, toAccountNumber: b1.accountNumber, amount: "10.00", idempotencyKey: "same-key-123456" }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ transfer: { id: string }; replayed: boolean }>[];
    expect(fulfilled.length).toBe(10);
    expect(new Set(fulfilled.map((f) => f.value.transfer.id)).size).toBe(1);
    expect(fulfilled.filter((f) => !f.value.replayed).length).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: src.id } })).balance).toBe(99_000n);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    await executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: b1.accountNumber, amount: "1.00", idempotencyKey: "conflict-key-1" });
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: b1.accountNumber, amount: "2.00", idempotencyKey: "conflict-key-1" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("blocks debits and credits on frozen accounts, and debits on dormant/closed ones", async () => {
    const frozen = await makeAccount(custB, branchId, { status: "FROZEN" });
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: frozen.accountNumber, amount: "1.00", idempotencyKey: "frozen-in-1" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_FROZEN" });
    const frozenSrc = await makeAccount(custA, branchId);
    await fund(frozenSrc.id, 10_000n);
    await prisma.account.update({ where: { id: frozenSrc.id }, data: { status: "FROZEN" } });
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: frozenSrc.id, toAccountNumber: b1.accountNumber, amount: "1.00", idempotencyKey: "frozen-out-1" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_FROZEN" });
    await prisma.account.update({ where: { id: frozenSrc.id }, data: { status: "DORMANT" } });
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: frozenSrc.id, toAccountNumber: b1.accountNumber, amount: "1.00", idempotencyKey: "dormant-out-1" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DORMANT" });
    const closed = await makeAccount(custB, branchId, { status: "CLOSED" });
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: closed.accountNumber, amount: "1.00", idempotencyKey: "closed-in-1" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_CLOSED" });
  });

  it("rejects invalid IBAN check digits", async () => {
    const bad = b1.accountNumber.slice(0, 2) + (b1.accountNumber[2] === "9" ? "1" : "9") + b1.accountNumber.slice(3);
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: bad, amount: "1.00", idempotencyKey: "badiban-1" }),
    ).rejects.toMatchObject({ code: "INVALID_IBAN" });
  });

  it("customer cannot debit another customer's account", async () => {
    await expect(
      executeTransfer({ kind: "CUSTOMER", customerId: custB, actor: sys }, { fromAccountId: a1.id, toAccountNumber: b1.accountNumber, amount: "1.00", idempotencyKey: "steal-0001" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("external transfer goes to clearing suspense with fee, then batch submit + settle via MOCK adapter", async () => {
    const ops = principal(await makeStaff("OPERATIONS", null));
    const ext = makeIban("0005", 123456789, "EG", "0001"); // fictional other bank
    const r = await executeTransfer({ kind: "CUSTOMER", customerId: custA, actor: sys }, { fromAccountId: a1.id, toAccountNumber: ext, toName: "Test Payee", amount: "100.00", idempotencyKey: "ext-000001" });
    expect(r.transfer.status).toBe("SENT_TO_CLEARING");
    expect(r.transfer.feeAmount).toBe(500n); // min fee EGP 5.00
    const batch = await prisma.clearingBatch.findUniqueOrThrow({ where: { id: r.transfer.clearingBatchId! } });
    expect(batch.totalAmount).toBe(10_000n);
    const sub = await submitBatch(ops, actorOf(ops), batch.id);
    expect(sub.fileContent).toContain("MOCK ACH FILE");
    await settleBatch(ops, actorOf(ops), batch.id);
    expect((await prisma.transfer.findUniqueOrThrow({ where: { id: r.transfer.id } })).status).toBe("SETTLED");
    const rec = await reconcile();
    expect(rec.breaks).toEqual([]);
  });
});
