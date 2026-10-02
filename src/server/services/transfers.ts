import { z } from "zod";
import type { Currency, Transfer } from "@prisma/client";
import { prisma, Tx, nextSeq, withTx, isUniqueViolation } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { bankCodeOf, BANK_CODE, isValidIban } from "@/lib/iban";
import { toMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal, type LineInput } from "@/server/ledger";
import { assertBranchAccess, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { computeFee } from "./fees";
import { getClearingAdapter } from "./clearing-adapter";
import { notify } from "./notify";

export const BANKS: Record<string, string> = {
  "0099": "Neo Bank (Demo)",
  "0001": "Demo National Bank (fictional)",
  "0002": "Demo Misr Bank (fictional)",
  "0003": "Demo Commercial Bank (fictional)",
};

export const transferInput = z.object({
  fromAccountId: z.string(),
  toAccountNumber: z.string().transform((s) => s.replace(/\s+/g, "").toUpperCase()),
  toName: z.string().max(140).optional(),
  amount: z.string(),
  description: z.string().max(140).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type TransferInput = z.infer<typeof transferInput>;

export type Initiator =
  | { kind: "STAFF"; staff: StaffPrincipal; actor: Actor }
  | { kind: "CUSTOMER"; customerId: string; actor: Actor }
  | { kind: "SYSTEM"; actor: Actor; postedAt?: Date };

/**
 * Executes an internal (same bank) or external (via clearing) transfer atomically.
 * Idempotent: the same initiator + idempotencyKey always returns the same transfer.
 */
export async function executeTransfer(init: Initiator, raw: unknown): Promise<{ transfer: Transfer; replayed: boolean }> {
  const input = transferInput.parse(raw);
  const amount = toMinor(input.amount);
  if (amount <= 0n) throw Errors.validation("Amount must be positive");
  if (!isValidIban(input.toAccountNumber)) throw new AppError("INVALID_IBAN", 422, "Destination account number is invalid (check digits)");

  const initiatorId = init.kind === "STAFF" ? init.staff.id : init.kind === "CUSTOMER" ? init.customerId : "system";
  const key = `transfer:${init.kind}:${initiatorId}:${input.idempotencyKey}`;

  const from = await prisma.account.findUnique({ where: { id: input.fromAccountId } });
  if (!from) throw Errors.notFound("Source account");
  if (init.kind === "CUSTOMER" && from.customerId !== init.customerId) throw Errors.notFound("Source account");
  if (init.kind === "STAFF") {
    requirePerm(init.staff, "transfer.create");
    assertBranchAccess(init.staff, from.branchId);
  }
  if (from.type === "TERM_DEPOSIT") throw new AppError("NOT_ALLOWED", 422, "Transfers from term deposits are not allowed");
  if (from.accountNumber === input.toAccountNumber) throw Errors.validation("Source and destination are the same account");

  const internal = bankCodeOf(input.toAccountNumber) === BANK_CODE;
  const replay = async () => {
    const e = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key } });
    const t = e ? await prisma.transfer.findFirst({ where: { journalEntryId: e.id } }) : null;
    if (!t) throw Errors.conflict("Duplicate request in progress");
    return { transfer: t, replayed: true };
  };

  try {
    return await withTx(async (tx) => {
      const channel = init.kind === "CUSTOMER" ? "PORTAL" : init.kind === "SYSTEM" ? "SYSTEM" : "BRANCH";
      const postedAt = init.kind === "SYSTEM" ? init.postedAt : undefined;
      const ref = `TRF${String(await nextSeq(tx, "nb_transfer_seq")).padStart(9, "0")}`;
      if (internal) {
        const to = await tx.account.findUnique({ where: { accountNumber: input.toAccountNumber }, include: { customer: true } });
        if (!to) throw new AppError("BENEFICIARY_NOT_FOUND", 422, "Destination account not found at Neo Bank");
        if (to.type === "TERM_DEPOSIT") throw new AppError("NOT_ALLOWED", 422, "Cannot transfer into a term deposit");
        if (to.currency !== from.currency) throw new AppError("CURRENCY_MISMATCH", 422, "Cross-currency transfers are not supported");
        const kind = to.customerId === from.customerId ? "OWN" : "INTERNAL";
        const { entry, replayed } = await postJournal(tx, {
          idempotencyKey: key, type: "TRANSFER", currency: from.currency, channel, postedAt,
          description: input.description || `Transfer ${ref}`,
          branchId: from.branchId, staffId: init.kind === "STAFF" ? init.staff.id : null, customerId: init.kind === "CUSTOMER" ? init.customerId : null,
          reference: ref,
          lines: [
            { accountId: from.id, debit: amount, narrative: `To ${to.accountNumber} ${input.description ?? ""}`.trim() },
            { accountId: to.id, credit: amount, narrative: `From ${from.accountNumber} ${input.description ?? ""}`.trim() },
          ],
        });
        if (replayed) {
          const t = await tx.transfer.findFirst({ where: { journalEntryId: entry.id } });
          return { transfer: t!, replayed: true };
        }
        const t = await tx.transfer.create({
          data: {
            reference: ref, kind, fromAccountId: from.id, toAccountId: to.id, toAccountNumber: to.accountNumber, toBankCode: BANK_CODE, toName: to.customer.nameEn,
            amount, currency: from.currency, status: "COMPLETED", description: input.description, channel, journalEntryId: entry.id,
            initiatedByStaffId: init.kind === "STAFF" ? init.staff.id : null, initiatedByCustomerId: init.kind === "CUSTOMER" ? init.customerId : null,
            createdAt: postedAt,
          },
        });
        if (init.kind !== "SYSTEM") {
          await notify(tx, to.customerId, { titleAr: "تحويل وارد", titleEn: "Incoming transfer", bodyAr: `تم إضافة ${input.amount} ${from.currency} إلى حسابك`, bodyEn: `${input.amount} ${from.currency} credited to ${to.accountNumber}` });
        }
        await audit(init.actor, "TRANSFER_INTERNAL", { type: "Transfer", id: t.id }, undefined, { ref, amount, from: from.accountNumber, to: to.accountNumber }, tx);
        return { transfer: t, replayed: false };
      }

      // External: debit customer, credit clearing suspense; fee to income. Added to the open clearing batch.
      const bankCode = bankCodeOf(input.toAccountNumber);
      if (!BANKS[bankCode]) throw new AppError("UNKNOWN_BANK", 422, "Destination bank not recognised");
      if (!input.toName) throw Errors.validation("Beneficiary name is required for external transfers");
      const { fee } = await computeFee(tx, "EXTERNAL_TRANSFER", amount, from.currency);
      const lines: LineInput[] = [
        { accountId: from.id, debit: amount + fee, narrative: `External transfer ${ref} to ${input.toAccountNumber}` },
        { glCode: GL.CLEARING_OUTGOING, credit: amount, narrative: `Clearing ${ref}` },
      ];
      if (fee > 0n) lines.push({ glCode: GL.FEE_INCOME, credit: fee, narrative: `Fee ${ref}` });
      const { entry, replayed } = await postJournal(tx, {
        idempotencyKey: key, type: "EXTERNAL_TRANSFER", currency: from.currency, channel, postedAt,
        description: input.description || `External transfer ${ref}`, branchId: from.branchId,
        staffId: init.kind === "STAFF" ? init.staff.id : null, customerId: init.kind === "CUSTOMER" ? init.customerId : null, reference: ref, lines,
      });
      if (replayed) {
        const t = await tx.transfer.findFirst({ where: { journalEntryId: entry.id } });
        return { transfer: t!, replayed: true };
      }
      const batch = await openBatch(tx, from.currency);
      const t = await tx.transfer.create({
        data: {
          reference: ref, kind: "EXTERNAL", fromAccountId: from.id, toAccountNumber: input.toAccountNumber, toBankCode: bankCode, toName: input.toName,
          amount, feeAmount: fee, currency: from.currency, status: "SENT_TO_CLEARING", description: input.description, channel, journalEntryId: entry.id,
          clearingBatchId: batch.id, initiatedByStaffId: init.kind === "STAFF" ? init.staff.id : null, initiatedByCustomerId: init.kind === "CUSTOMER" ? init.customerId : null,
          createdAt: postedAt,
        },
      });
      await tx.clearingBatch.update({ where: { id: batch.id }, data: { itemCount: { increment: 1 }, totalAmount: { increment: amount } } });
      await audit(init.actor, "TRANSFER_EXTERNAL", { type: "Transfer", id: t.id }, undefined, { ref, amount, fee, to: input.toAccountNumber, bank: bankCode }, tx);
      return { transfer: t, replayed: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) return replay();
    throw e;
  }
}

async function openBatch(tx: Tx, currency: Currency) {
  const adapter = getClearingAdapter();
  // Serialize batch creation per currency with an advisory lock.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"clearing-batch-" + currency}))`;
  const open = await tx.clearingBatch.findFirst({ where: { currency, status: "OPEN" } });
  if (open) return open;
  const n = await nextSeq(tx, "nb_batch_seq");
  return tx.clearingBatch.create({ data: { batchNo: `CLR-${currency}-${String(n).padStart(5, "0")}`, adapter: adapter.name, currency } });
}

export async function submitBatch(staff: StaffPrincipal, actor: Actor, batchId: string) {
  requirePerm(staff, "clearing.manage");
  const adapter = getClearingAdapter();
  return withTx(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "ClearingBatch" WHERE id = ${batchId} FOR UPDATE`;
    const batch = await tx.clearingBatch.findUnique({ where: { id: batchId }, include: { transfers: true } });
    if (!batch) throw Errors.notFound("Batch");
    if (batch.status !== "OPEN") throw new AppError("INVALID_STATE", 409, "Batch is not open");
    if (!batch.transfers.length) throw Errors.validation("Batch is empty");
    const file = adapter.buildFile(batch, batch.transfers);
    const ack = await adapter.submit(file);
    const after = await tx.clearingBatch.update({ where: { id: batchId }, data: { status: "SUBMITTED", fileContent: file, submittedAt: new Date() } });
    await audit(actor, "CLEARING_BATCH_SUBMITTED", { type: "ClearingBatch", id: batchId }, { status: "OPEN" }, { status: "SUBMITTED", ack }, tx);
    return after;
  });
}

/** Settlement: clearing suspense is relieved against the central-bank settlement account. */
export async function settleBatch(staff: StaffPrincipal, actor: Actor, batchId: string) {
  requirePerm(staff, "clearing.manage");
  return withTx(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "ClearingBatch" WHERE id = ${batchId} FOR UPDATE`;
    const batch = await tx.clearingBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw Errors.notFound("Batch");
    if (batch.status !== "SUBMITTED") throw new AppError("INVALID_STATE", 409, "Batch must be submitted first");
    const { entry } = await postJournal(tx, {
      idempotencyKey: `clearing-settle:${batch.id}`, type: "CLEARING_SETTLEMENT", currency: batch.currency, channel: "SYSTEM",
      description: `Settlement of ${batch.batchNo} (MOCK clearing)`, staffId: staff.id, reference: batch.batchNo,
      lines: [{ glCode: GL.CLEARING_OUTGOING, debit: batch.totalAmount }, { glCode: GL.DUE_FROM_CBE, credit: batch.totalAmount }],
    });
    await tx.transfer.updateMany({ where: { clearingBatchId: batch.id }, data: { status: "SETTLED" } });
    const after = await tx.clearingBatch.update({ where: { id: batch.id }, data: { status: "SETTLED", settledAt: new Date(), settlementEntryId: entry.id } });
    await audit(actor, "CLEARING_BATCH_SETTLED", { type: "ClearingBatch", id: batch.id }, { status: "SUBMITTED" }, { status: "SETTLED" }, tx);
    return after;
  });
}
