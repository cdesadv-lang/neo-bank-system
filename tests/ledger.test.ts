import { describe, it, expect, beforeAll } from "vitest";
import { prisma, withTx } from "@/lib/db";
import { postJournal, reverseJournal } from "@/server/ledger";
import { resetDb, makeBranch, makeCustomer, makeAccount, fund, ledgerBalanceOfAccount } from "./helpers";

describe("double-entry ledger", () => {
  let accA: string, accB: string;
  beforeAll(async () => {
    await resetDb();
    const b = await makeBranch();
    const c = await makeCustomer(b.id);
    accA = (await makeAccount(c.id, b.id)).id;
    accB = (await makeAccount(c.id, b.id)).id;
    await fund(accA, 100_000n);
  });

  it("rejects unbalanced journals", async () => {
    await expect(
      withTx((tx) => postJournal(tx, { idempotencyKey: "unbal-1", type: "MANUAL", description: "x", currency: "EGP", lines: [{ glCode: "1100", debit: 100n }, { accountId: accA, credit: 99n }] })),
    ).rejects.toMatchObject({ code: "UNBALANCED_JOURNAL" });
  });

  it("rejects lines that are both/neither debit and credit or negative", async () => {
    await expect(
      withTx((tx) => postJournal(tx, { idempotencyKey: "bad-1", type: "MANUAL", description: "x", currency: "EGP", lines: [{ glCode: "1100", debit: -5n }, { accountId: accA, credit: -5n }] })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("database rejects unbalanced lines inserted directly (deferred constraint trigger)", async () => {
    const gl = await prisma.glAccount.findUniqueOrThrow({ where: { code: "1100" } });
    await expect(
      prisma.journalEntry.create({
        data: { entryNo: "JE-raw", idempotencyKey: "raw-unbalanced", type: "MANUAL", description: "raw", currency: "EGP", valueDate: new Date(), lines: { create: [{ glAccountId: gl.id, debit: 10n, currency: "EGP" }] } },
      }),
    ).rejects.toThrow(/UNBALANCED_JOURNAL/);
  });

  it("posted lines are immutable at the database level", async () => {
    const line = await prisma.journalLine.findFirstOrThrow();
    await expect(prisma.journalLine.update({ where: { id: line.id }, data: { credit: 1n } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    const entry = await prisma.journalEntry.findFirstOrThrow();
    await expect(prisma.journalEntry.update({ where: { id: entry.id }, data: { description: "tampered" } })).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it("total debits equal total credits across the whole ledger and per currency", async () => {
    const rows = await prisma.journalLine.groupBy({ by: ["currency"], _sum: { debit: true, credit: true } });
    for (const r of rows) expect(r._sum.debit).toBe(r._sum.credit);
  });

  it("reversal posts a mirror entry and restores balances; original is marked REVERSED", async () => {
    const { entry } = await withTx((tx) =>
      postJournal(tx, { idempotencyKey: "tr-rev-1", type: "TRANSFER", description: "t", currency: "EGP", skipAml: true, lines: [{ accountId: accA, debit: 2_000n }, { accountId: accB, credit: 2_000n }] }),
    );
    const beforeA = (await prisma.account.findUniqueOrThrow({ where: { id: accA } })).balance;
    await withTx((tx) => reverseJournal(tx, entry.id, { reason: "test" }));
    const afterA = (await prisma.account.findUniqueOrThrow({ where: { id: accA } })).balance;
    expect(afterA - beforeA).toBe(2_000n);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe("REVERSED");
    // reversing twice is idempotent (returns the same reversal)
    const again = await withTx((tx) => reverseJournal(tx, entry.id, { reason: "test" }));
    expect(again.replayed).toBe(true);
  });

  it("sub-ledger balances equal ledger sums", async () => {
    for (const id of [accA, accB]) {
      const acc = await prisma.account.findUniqueOrThrow({ where: { id } });
      expect(acc.balance).toBe(await ledgerBalanceOfAccount(id));
    }
  });

  it("control GL accounts cannot be posted without sub-ledger reference", async () => {
    await expect(
      withTx((tx) => postJournal(tx, { idempotencyKey: "ctl-1", type: "MANUAL", description: "x", currency: "EGP", lines: [{ glCode: "2010", debit: 5n }, { glCode: "1100", credit: 5n }] })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
