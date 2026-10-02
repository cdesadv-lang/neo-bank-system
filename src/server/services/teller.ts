import { z } from "zod";
import type { Currency } from "@prisma/client";
import { prisma, Tx, withTx, isUniqueViolation } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { todayStr, dateOnly } from "@/lib/dates";
import { toEgpEquivalent } from "@/lib/fx";
import { toMinor, minorToString } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal, type LineInput } from "@/server/ledger";
import { assertBranchAccess, branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { createApproval } from "./approval-request";
import { computeFee } from "./fees";
import { consumeCountSession } from "./cash-count";

/** Cash withdrawals at or above this EGP-equivalent need a branch manager (maker-checker). */
export const LARGE_CASH_THRESHOLD = 25_000_000n; // EGP 250,000.00

export async function listTills(staff: StaffPrincipal) {
  requirePerm(staff, "till.read");
  return prisma.till.findMany({ where: { ...branchWhere(staff) }, include: { branch: true }, orderBy: [{ branchId: "asc" }, { kind: "desc" }, { code: "asc" }] });
}

async function myOpenTill(tx: Tx, staff: StaffPrincipal, currency: Currency) {
  const till = await tx.till.findFirst({ where: { assignedToId: staff.id, kind: "TELLER", currency } });
  if (!till) throw new AppError("NO_TILL", 422, `No ${currency} teller till assigned to you`);
  if (till.status !== "OPEN") throw new AppError("TILL_CLOSED", 422, `Your ${currency} till is closed; open it first`);
  return till;
}

const cashInput = z.object({
  accountId: z.string(),
  amount: z.string(),
  countSessionId: z.string().optional(), // cash-counter result bound to this operation
  narrative: z.string().max(140).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

/** Tellers may key in the IBAN instead of the internal id. */
function accountRef(ref: string) {
  const iban = ref.replace(/\s+/g, "").toUpperCase();
  return iban.startsWith("EG") ? { accountNumber: iban } : { id: ref };
}

async function postCash(staff: StaffPrincipal, actor: Actor, kind: "CASH_DEPOSIT" | "CASH_WITHDRAWAL", input: z.infer<typeof cashInput>, tillOwner?: StaffPrincipal) {
  const amount = toMinor(input.amount);
  if (amount <= 0n) throw Errors.validation("Amount must be positive");
  const key = `cash:${(tillOwner ?? staff).id}:${input.idempotencyKey}`;
  try {
    return await withTx(async (tx) => {
      const acc = await tx.account.findFirst({ where: accountRef(input.accountId), include: { customer: true } });
      if (!acc) throw Errors.notFound("Account");
      assertBranchAccess(tillOwner ?? staff, acc.branchId);
      if (acc.type === "TERM_DEPOSIT") throw new AppError("NOT_ALLOWED", 422, "Cash operations are not allowed on term deposits");
      const till = await myOpenTill(tx, tillOwner ?? staff, acc.currency);
      if (input.countSessionId) {
        const prior = await tx.journalEntry.findUnique({ where: { idempotencyKey: key } });
        if (prior) return { entry: prior, replayed: true };
        await consumeCountSession(tx, input.countSessionId, tillOwner ?? staff, { expectedTotal: amount, purpose: kind === "CASH_DEPOSIT" ? "DEPOSIT" : "WITHDRAWAL", currency: acc.currency, ref: key });
      }
      if (till.branchId !== acc.branchId && (tillOwner ?? staff).branchId !== till.branchId) throw Errors.forbidden();
      const lines: LineInput[] =
        kind === "CASH_DEPOSIT"
          ? [{ tillId: till.id, debit: amount, narrative: input.narrative ?? "Cash deposit" }, { accountId: acc.id, credit: amount, narrative: input.narrative ?? "Cash deposit" }]
          : [{ accountId: acc.id, debit: amount, narrative: input.narrative ?? "Cash withdrawal" }, { tillId: till.id, credit: amount, narrative: input.narrative ?? "Cash withdrawal" }];
      if (kind === "CASH_WITHDRAWAL") {
        const { fee } = await computeFee(tx, "CASH_WITHDRAWAL", amount, acc.currency);
        if (fee > 0n) lines.push({ accountId: acc.id, debit: fee, narrative: "Cash withdrawal fee" }, { glCode: GL.FEE_INCOME, credit: fee, narrative: "Cash withdrawal fee" });
      }
      // merge duplicate account lines into one net debit for clarity
      const res = await postJournal(tx, {
        idempotencyKey: key, type: kind, currency: acc.currency, channel: "BRANCH", branchId: till.branchId, staffId: staff.id,
        description: `${kind === "CASH_DEPOSIT" ? "Cash deposit" : "Cash withdrawal"} — ${acc.customer.nameEn}`, lines,
      });
      if (!res.replayed) await audit(actor, kind, { type: "Account", id: acc.id }, undefined, { amount, till: till.code, entry: res.entry.entryNo }, tx);
      return res;
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) {
      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { idempotencyKey: key } });
      return { entry, replayed: true };
    }
    throw e;
  }
}

export async function cashDeposit(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "cash.deposit");
  return postCash(staff, actor, "CASH_DEPOSIT", cashInput.parse(raw));
}

export async function cashWithdrawal(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "cash.withdraw");
  const input = cashInput.parse(raw);
  const acc = await prisma.account.findFirst({ where: accountRef(input.accountId) });
  if (!acc) throw Errors.notFound("Account");
  assertBranchAccess(staff, acc.branchId);
  input.accountId = acc.id;
  const amount = toMinor(input.amount);
  if (toEgpEquivalent(amount, acc.currency) >= LARGE_CASH_THRESHOLD) {
    const req = await createApproval(prisma, actor, {
      type: "LARGE_CASH",
      summary: `Large cash withdrawal ${minorToString(amount)} ${acc.currency} from ${acc.accountNumber}`,
      payload: { ...input, makerId: staff.id },
      makerId: staff.id, entityType: "Account", entityId: acc.id, branchId: acc.branchId,
    });
    return { pendingApproval: true, approvalId: req.id };
  }
  return postCash(staff, actor, "CASH_WITHDRAWAL", input);
}

/** Called by the approval engine: posts the withdrawal against the maker's till. */
export async function executeLargeCash(payload: z.infer<typeof cashInput> & { makerId: string }, checker: StaffPrincipal, actor: Actor) {
  const maker = await prisma.staff.findUniqueOrThrow({ where: { id: payload.makerId } });
  const makerP: StaffPrincipal = { id: maker.id, username: maker.username, role: maker.role, branchId: maker.branchId, fullNameAr: maker.fullNameAr, fullNameEn: maker.fullNameEn };
  return postCash(checker, actor, "CASH_WITHDRAWAL", payload, makerP);
}

const openTillInput = z.object({ tillId: z.string() });

export async function openTill(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.operate");
  const { tillId } = openTillInput.parse(raw);
  const till = await prisma.till.findUnique({ where: { id: tillId } });
  if (!till) throw Errors.notFound("Till");
  assertBranchAccess(staff, till.branchId);
  if (till.kind === "TELLER" && till.assignedToId !== staff.id && !["BRANCH_MANAGER", "SUPER_ADMIN"].includes(staff.role)) throw Errors.forbidden("Not your till");
  if (till.status === "OPEN") throw Errors.conflict("Till already open");
  const after = await prisma.till.update({ where: { id: tillId }, data: { status: "OPEN", openedAt: new Date() } });
  await audit(actor, "TILL_OPENED", { type: "Till", id: tillId }, { status: till.status }, { status: "OPEN" });
  return after;
}

const moveInput = z.object({ fromTillId: z.string(), toTillId: z.string(), amount: z.string(), idempotencyKey: z.string().min(8) });

/** Vault <-> till cash movements (branch manager). */
export async function moveCash(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.manage");
  const input = moveInput.parse(raw);
  const amount = toMinor(input.amount);
  return withTx(async (tx) => {
    const [a, b] = await Promise.all([tx.till.findUnique({ where: { id: input.fromTillId } }), tx.till.findUnique({ where: { id: input.toTillId } })]);
    if (!a || !b) throw Errors.notFound("Till");
    assertBranchAccess(staff, a.branchId);
    assertBranchAccess(staff, b.branchId);
    if (a.branchId !== b.branchId) throw Errors.validation("Cash can only move within a branch");
    if (a.currency !== b.currency) throw Errors.validation("Currency mismatch");
    if (b.kind === "TELLER" && b.status !== "OPEN") throw new AppError("TILL_CLOSED", 422, "Destination till is closed");
    const res = await postJournal(tx, {
      idempotencyKey: `till-move:${staff.id}:${input.idempotencyKey}`, type: "TILL_TRANSFER", currency: a.currency, channel: "BRANCH",
      branchId: a.branchId, staffId: staff.id, description: `Cash ${a.code} → ${b.code}`,
      lines: [{ tillId: b.id, debit: amount }, { tillId: a.id, credit: amount }],
    });
    await audit(actor, "TILL_CASH_MOVED", { type: "Till", id: a.id }, undefined, { from: a.code, to: b.code, amount }, tx);
    return res;
  });
}

const balanceInput = z.object({ tillId: z.string(), counted: z.string().optional(), countSessionId: z.string().optional(), denominations: z.record(z.string(), z.number()).optional() });

/** End-of-day till balancing: compare counted cash to system balance, book variance to Cash Over/Short, close till. */
export async function balanceTill(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.operate");
  const input = balanceInput.parse(raw);
  if (!input.counted && !input.countSessionId) throw Errors.validation("Provide counted amount or a cash-counter session");
  return withTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Till" WHERE id = ${input.tillId} FOR UPDATE`;
    const till = await tx.till.findUnique({ where: { id: input.tillId } });
    if (!till) throw Errors.notFound("Till");
    assertBranchAccess(staff, till.branchId);
    if (till.kind === "TELLER" && till.assignedToId !== staff.id && !["BRANCH_MANAGER", "SUPER_ADMIN"].includes(staff.role)) throw Errors.forbidden("Not your till");
    if (till.status !== "OPEN") throw new AppError("TILL_CLOSED", 422, "Till is not open");
    let counted: bigint;
    let denominations = input.denominations;
    if (input.countSessionId) {
      const s = await consumeCountSession(tx, input.countSessionId, staff, { purpose: "TILL_BALANCING", currency: till.currency, ref: `balancing:${till.id}` });
      counted = s.total;
      denominations = s.denominations as Record<string, number>;
      if (input.counted && toMinor(input.counted) !== counted) throw Errors.validation("Manual amount differs from device count");
    } else counted = toMinor(input.counted!);
    const variance = counted - till.balance;
    const date = todayStr();
    let varianceEntryId: string | undefined;
    if (variance !== 0n) {
      const abs = variance < 0n ? -variance : variance;
      const { entry } = await postJournal(tx, {
        idempotencyKey: `till-variance:${till.id}:${date}:${Date.now()}`, type: "CASH_VARIANCE", currency: till.currency, channel: "BRANCH",
        branchId: till.branchId, staffId: staff.id, description: `Till ${till.code} ${variance > 0n ? "overage" : "shortage"} at balancing`,
        lines: variance > 0n
          ? [{ tillId: till.id, debit: abs }, { glCode: GL.CASH_OVER_SHORT, credit: abs }]
          : [{ glCode: GL.CASH_OVER_SHORT, debit: abs }, { tillId: till.id, credit: abs }],
      });
      varianceEntryId = entry.id;
    }
    const rec = await tx.tillBalancing.create({
      data: { tillId: till.id, businessDate: dateOnly(date), systemBalance: till.balance, countedBalance: counted, variance, denominations, staffId: staff.id, varianceEntryId },
    });
    if (till.kind === "TELLER") await tx.till.update({ where: { id: till.id }, data: { status: "CLOSED" } });
    await audit(actor, "TILL_BALANCED", { type: "Till", id: till.id }, { balance: till.balance }, { counted, variance }, tx);
    return rec;
  });
}
