import { createHash } from "crypto";
import type { Currency, JournalEntry } from "@prisma/client";
import { Tx, nextSeq } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { dateOnly, todayStr } from "@/lib/dates";
import { GL } from "./gl";
import { evaluateAml } from "./aml";

export type LineInput = {
  glCode?: string; // required unless accountId/tillId/loanId given (then derived)
  accountId?: string;
  tillId?: string;
  loanId?: string;
  debit?: bigint;
  credit?: bigint;
  narrative?: string;
};

export type PostInput = {
  idempotencyKey: string;
  type: string;
  description: string;
  currency: Currency;
  lines: LineInput[];
  channel?: "BRANCH" | "PORTAL" | "SYSTEM" | "API";
  branchId?: string | null;
  staffId?: string | null;
  customerId?: string | null;
  reference?: string | null;
  metadata?: Record<string, unknown>;
  valueDate?: string; // YYYY-MM-DD
  postedAt?: Date; // internal use only (seed / batch backdating)
  /** Allow posting to FROZEN / DORMANT accounts (approved reversals, system interest). Never CLOSED. */
  overrideStatus?: boolean;
  /** Skip AML evaluation (internal system entries). */
  skipAml?: boolean;
  /** Internal: set when posting a reversal. */
  reversalOfId?: string;
};

export type PostResult = { entry: JournalEntry; replayed: boolean };

const AML_TYPES = new Set(["CASH_DEPOSIT", "CASH_WITHDRAWAL", "TRANSFER", "EXTERNAL_TRANSFER", "BILL_PAYMENT"]);

export function hashRequest(input: PostInput): string {
  const canon = JSON.stringify({
    t: input.type,
    c: input.currency,
    l: input.lines.map((l) => [l.glCode ?? "", l.accountId ?? "", l.tillId ?? "", l.loanId ?? "", String(l.debit ?? 0n), String(l.credit ?? 0n)]),
  });
  return createHash("sha256").update(canon).digest("hex");
}

/** Lock sub-ledger rows in a deterministic global order (accounts, tills, loans; each by id) to avoid deadlocks. */
export async function lockRows(tx: Tx, ids: { accountIds?: string[]; tillIds?: string[]; loanIds?: string[] }) {
  const acc = [...new Set(ids.accountIds ?? [])].sort();
  const tills = [...new Set(ids.tillIds ?? [])].sort();
  const loans = [...new Set(ids.loanIds ?? [])].sort();
  if (acc.length) await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ANY(${acc}::text[]) ORDER BY id FOR UPDATE`;
  if (tills.length) await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ANY(${tills}::text[]) ORDER BY id FOR UPDATE`;
  if (loans.length) await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ANY(${loans}::text[]) ORDER BY id FOR UPDATE`;
}

/**
 * The single posting engine. Every money movement in the bank goes through here.
 * Must be called inside a transaction (withTx). Guarantees:
 *  - balanced entry (debits == credits), enforced here AND by a deferred DB constraint trigger
 *  - idempotency (same key -> same entry, different payload -> 409)
 *  - row locks on every touched sub-ledger row, balances updated atomically
 *  - no negative customer balances (insufficient funds), status rules (frozen/closed/dormant/pending)
 */
export async function postJournal(tx: Tx, input: PostInput): Promise<PostResult> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw Errors.validation("idempotencyKey required");
  if (input.lines.length < 2) throw Errors.validation("A journal needs at least two lines");

  let totalDr = 0n;
  let totalCr = 0n;
  for (const l of input.lines) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (typeof d !== "bigint" || typeof c !== "bigint") throw Errors.validation("Amounts must be integer minor units");
    if (d < 0n || c < 0n || (d > 0n) === (c > 0n)) throw Errors.validation("Each line must be either a positive debit or a positive credit");
    totalDr += d;
    totalCr += c;
  }
  if (totalDr !== totalCr) throw new AppError("UNBALANCED_JOURNAL", 422, `Unbalanced journal: Dr ${totalDr} != Cr ${totalCr}`);

  const requestHash = hashRequest(input);
  const accountIds = input.lines.flatMap((l) => (l.accountId ? [l.accountId] : []));
  const tillIds = input.lines.flatMap((l) => (l.tillId ? [l.tillId] : []));
  const loanIds = input.lines.flatMap((l) => (l.loanId ? [l.loanId] : []));

  await lockRows(tx, { accountIds, tillIds, loanIds });

  // Idempotency check AFTER acquiring locks: a concurrent duplicate waits for the first, then sees its entry.
  const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.requestHash && existing.requestHash !== requestHash) {
      throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key reused with a different request");
    }
    return { entry: existing, replayed: true };
  }

  const glRows = await tx.glAccount.findMany();
  const glByCode = new Map(glRows.map((g) => [g.code, g]));
  const glById = new Map(glRows.map((g) => [g.id, g]));

  const accounts = accountIds.length ? await tx.account.findMany({ where: { id: { in: accountIds } } }) : [];
  const tills = tillIds.length ? await tx.till.findMany({ where: { id: { in: tillIds } } }) : [];
  const loans = loanIds.length ? await tx.loan.findMany({ where: { id: { in: loanIds } } }) : [];
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const tillById = new Map(tills.map((t) => [t.id, t]));
  const loanById = new Map(loans.map((l) => [l.id, l]));

  const newAcc = new Map<string, bigint>(accounts.map((a) => [a.id, a.balance]));
  const newTill = new Map<string, bigint>(tills.map((t) => [t.id, t.balance]));
  const newLoan = new Map<string, bigint>(loans.map((l) => [l.id, l.outstandingPrincipal]));

  const resolved: { glAccountId: string; accountId?: string; tillId?: string; loanId?: string; debit: bigint; credit: bigint; narrative?: string; balanceAfter?: bigint }[] = [];

  for (const l of input.lines) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    const refs = [l.accountId, l.tillId, l.loanId].filter(Boolean).length;
    if (refs > 1) throw Errors.validation("A line may reference only one sub-ledger");
    let glId: string;
    let balanceAfter: bigint | undefined;
    if (l.accountId) {
      const a = accById.get(l.accountId);
      if (!a) throw Errors.notFound("Account");
      if (a.currency !== input.currency) throw new AppError("CURRENCY_MISMATCH", 422, `Account ${a.accountNumber} is ${a.currency}`);
      if (a.status === "CLOSED") throw new AppError("ACCOUNT_CLOSED", 422, `Account ${a.accountNumber} is closed`);
      if (a.status === "PENDING") throw new AppError("ACCOUNT_PENDING", 422, `Account ${a.accountNumber} is not active yet`);
      if (!input.overrideStatus) {
        if (a.status === "FROZEN") throw new AppError("ACCOUNT_FROZEN", 422, `Account ${a.accountNumber} is frozen`);
        if (a.status === "DORMANT" && d > 0n) throw new AppError("ACCOUNT_DORMANT", 422, `Account ${a.accountNumber} is dormant; reactivate first`);
      }
      const nb = (newAcc.get(a.id) ?? 0n) + c - d; // liability: credit increases
      if (nb < 0n) throw Errors.insufficientFunds();
      newAcc.set(a.id, nb);
      glId = a.glAccountId;
      balanceAfter = nb;
    } else if (l.tillId) {
      const t = tillById.get(l.tillId);
      if (!t) throw Errors.notFound("Till");
      if (t.currency !== input.currency) throw new AppError("CURRENCY_MISMATCH", 422, `Till ${t.code} is ${t.currency}`);
      const nb = (newTill.get(t.id) ?? 0n) + d - c; // asset: debit increases
      if (nb < 0n) throw new AppError("TILL_INSUFFICIENT_CASH", 422, `Not enough cash in ${t.code}`);
      newTill.set(t.id, nb);
      glId = glByCode.get(t.kind === "VAULT" ? GL.CASH_VAULT : GL.CASH_TILLS)!.id;
      balanceAfter = nb;
    } else if (l.loanId) {
      const ln = loanById.get(l.loanId);
      if (!ln) throw Errors.notFound("Loan");
      if (ln.currency !== input.currency) throw new AppError("CURRENCY_MISMATCH", 422, "Loan currency mismatch");
      const nb = (newLoan.get(ln.id) ?? 0n) + d - c;
      if (nb < 0n) throw new AppError("LOAN_OVERPAYMENT", 422, "Principal repayment exceeds outstanding");
      newLoan.set(ln.id, nb);
      glId = glByCode.get(GL.LOANS)!.id;
      balanceAfter = nb;
    } else {
      if (!l.glCode) throw Errors.validation("glCode required for GL-only lines");
      const g = glByCode.get(l.glCode);
      if (!g || !g.active) throw Errors.validation(`Unknown GL account ${l.glCode}`);
      if (g.isControl) throw Errors.validation(`GL ${g.code} is a control account; post via its sub-ledger`);
      if (!g.parentCode) throw Errors.validation(`GL ${g.code} is a header account`);
      glId = g.id;
    }
    if (!glById.has(glId)) throw Errors.validation("GL mapping missing");
    resolved.push({ glAccountId: glId, accountId: l.accountId, tillId: l.tillId, loanId: l.loanId, debit: d, credit: c, narrative: l.narrative, balanceAfter });
  }

  const seq = await nextSeq(tx, "nb_journal_seq");
  const now = input.postedAt ?? new Date();
  const entry = await tx.journalEntry.create({
    data: {
      entryNo: `JE${seq}`,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      type: input.type,
      description: input.description,
      currency: input.currency,
      valueDate: dateOnly(input.valueDate ?? todayStr(now)),
      postedAt: now,
      channel: input.channel ?? "BRANCH",
      branchId: input.branchId ?? null,
      createdByStaffId: input.staffId ?? null,
      createdByCustomerId: input.customerId ?? null,
      reference: input.reference ?? null,
      reversalOfId: input.reversalOfId ?? null,
      metadata: (input.metadata ?? undefined) as object | undefined,
      lines: {
        create: resolved.map((r) => ({
          glAccountId: r.glAccountId,
          accountId: r.accountId ?? null,
          tillId: r.tillId ?? null,
          loanId: r.loanId ?? null,
          debit: r.debit,
          credit: r.credit,
          currency: input.currency,
          narrative: r.narrative ?? null,
          balanceAfter: r.balanceAfter ?? null,
        })),
      },
    },
  });

  for (const [id, bal] of newAcc) {
    await tx.account.update({ where: { id }, data: { balance: bal, lastActivityAt: now } });
  }
  for (const [id, bal] of newTill) await tx.till.update({ where: { id }, data: { balance: bal } });
  for (const [id, bal] of newLoan) await tx.loan.update({ where: { id }, data: { outstandingPrincipal: bal } });

  if (!input.skipAml && AML_TYPES.has(input.type)) {
    await evaluateAml(tx, entry, resolved.filter((r) => r.accountId).map((r) => ({ account: accById.get(r.accountId!)!, debit: r.debit, credit: r.credit })));
  }

  return { entry, replayed: false };
}

/** Reverse a posted entry by posting the mirror entry. The original is marked REVERSED (allowed by DB trigger), never edited otherwise. */
export async function reverseJournal(tx: Tx, entryId: string, opts: { staffId?: string; reason: string; overrideStatus?: boolean }): Promise<PostResult> {
  const orig = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!orig) throw Errors.notFound("Journal entry");
  if (orig.type === "REVERSAL") throw Errors.validation("A reversal cannot itself be reversed");
  const gls = await tx.glAccount.findMany();
  const glById = new Map(gls.map((g) => [g.id, g]));
  const res = await postJournal(tx, {
    idempotencyKey: `reversal:${orig.id}`,
    type: "REVERSAL",
    description: `Reversal of ${orig.entryNo}: ${opts.reason}`,
    currency: orig.currency,
    channel: "BRANCH",
    branchId: orig.branchId,
    staffId: opts.staffId,
    reference: orig.entryNo,
    overrideStatus: opts.overrideStatus ?? true,
    skipAml: true,
    reversalOfId: orig.id,
    lines: orig.lines.map((l) => ({
      glCode: l.accountId || l.tillId || l.loanId ? undefined : glById.get(l.glAccountId)!.code,
      accountId: l.accountId ?? undefined,
      tillId: l.tillId ?? undefined,
      loanId: l.loanId ?? undefined,
      debit: l.credit,
      credit: l.debit,
      narrative: `Reversal: ${l.narrative ?? ""}`.trim(),
    })),
  });
  if (!res.replayed) {
    if (orig.status !== "POSTED") throw Errors.conflict("Entry already reversed");
    await tx.journalEntry.update({ where: { id: orig.id }, data: { status: "REVERSED" } });
  }
  return res;
}
