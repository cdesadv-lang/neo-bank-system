import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, withTx } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { toMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { postJournal, reverseJournal } from "@/server/ledger";
import { requirePerm, type StaffPrincipal, isBranchScoped } from "@/server/rbac";
import { createApproval } from "./approval-request";

export async function listJournals(staff: StaffPrincipal, f: { q?: string; type?: string; from?: Date; to?: Date; take?: number } = {}) {
  requirePerm(staff, "journal.read");
  const where: Prisma.JournalEntryWhereInput = {};
  if (isBranchScoped(staff)) where.branchId = staff.branchId;
  if (f.type) where.type = f.type;
  if (f.q) where.OR = [{ entryNo: { contains: f.q.toUpperCase() } }, { description: { contains: f.q, mode: "insensitive" } }, { reference: { contains: f.q.toUpperCase() } }];
  if (f.from || f.to) where.postedAt = { gte: f.from, lte: f.to };
  return prisma.journalEntry.findMany({ where, include: { lines: { include: { glAccount: true, account: true, till: true } } }, orderBy: { postedAt: "desc" }, take: f.take ?? 100 });
}

const manualInput = z.object({
  currency: z.enum(["EGP", "USD", "EUR", "SAR"]),
  description: z.string().min(3).max(200),
  lines: z.array(z.object({ glCode: z.string(), debit: z.string().optional(), credit: z.string().optional(), narrative: z.string().optional() })).min(2).max(20),
});

/** Manual GL journal (maker). Posting happens only after a FINANCE checker approves. */
export async function requestManualJournal(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "journal.manual");
  const input = manualInput.parse(raw);
  const gls = await prisma.glAccount.findMany({ where: { code: { in: input.lines.map((l) => l.glCode) } } });
  for (const l of input.lines) {
    const g = gls.find((x) => x.code === l.glCode);
    if (!g || !g.allowManualPosting || g.isControl) throw Errors.validation(`GL ${l.glCode} does not allow manual posting`);
  }
  const lines = input.lines.map((l) => ({ glCode: l.glCode, debit: l.debit ? toMinor(l.debit) : 0n, credit: l.credit ? toMinor(l.credit) : 0n, narrative: l.narrative }));
  const dr = lines.reduce((s, l) => s + l.debit, 0n);
  const cr = lines.reduce((s, l) => s + l.credit, 0n);
  if (dr !== cr || dr === 0n) throw Errors.validation("Manual journal must balance");
  return createApproval(prisma, actor, {
    type: "MANUAL_JOURNAL",
    summary: `Manual journal ${input.currency}: ${input.description}`,
    payload: { currency: input.currency, description: input.description, lines },
    makerId: staff.id,
    entityType: "JournalEntry",
  });
}

export async function executeManualJournal(approvalId: string, payload: { currency: "EGP" | "USD" | "EUR" | "SAR"; description: string; lines: { glCode: string; debit: string; credit: string; narrative?: string }[] }, checker: StaffPrincipal, actor: Actor) {
  return withTx(async (tx) => {
    const res = await postJournal(tx, {
      idempotencyKey: `manual:${approvalId}`, type: "MANUAL", currency: payload.currency, channel: "BRANCH", staffId: checker.id,
      description: payload.description,
      lines: payload.lines.map((l) => ({ glCode: l.glCode, debit: BigInt(l.debit), credit: BigInt(l.credit), narrative: l.narrative })),
    });
    await audit(actor, "MANUAL_JOURNAL_POSTED", { type: "JournalEntry", id: res.entry.id }, undefined, payload, tx);
    return res;
  });
}

const reversalInput = z.object({ reason: z.string().min(3).max(300) });

export async function requestReversal(staff: StaffPrincipal, actor: Actor, entryId: string, raw: unknown) {
  requirePerm(staff, "journal.reverse");
  const { reason } = reversalInput.parse(raw);
  const e = await prisma.journalEntry.findUnique({ where: { id: entryId } });
  if (!e) throw Errors.notFound("Journal entry");
  if (e.status !== "POSTED" || e.type === "REVERSAL") throw Errors.validation("Only posted, non-reversal entries can be reversed");
  const pending = await prisma.approvalRequest.findFirst({ where: { type: "JOURNAL_REVERSAL", entityId: entryId, status: "PENDING" } });
  if (pending) throw Errors.conflict("Reversal already pending");
  return createApproval(prisma, actor, { type: "JOURNAL_REVERSAL", summary: `Reverse ${e.entryNo}: ${reason}`, payload: { entryId, reason }, makerId: staff.id, entityType: "JournalEntry", entityId: entryId, branchId: e.branchId });
}

export async function executeReversal(payload: { entryId: string; reason: string }, checker: StaffPrincipal, actor: Actor) {
  return withTx(async (tx) => {
    const res = await reverseJournal(tx, payload.entryId, { staffId: checker.id, reason: payload.reason });
    await audit(actor, "JOURNAL_REVERSED", { type: "JournalEntry", id: payload.entryId }, { status: "POSTED" }, { status: "REVERSED", reversal: res.entry.entryNo }, tx);
    return res;
  });
}
