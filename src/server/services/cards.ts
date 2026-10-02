import { randomBytes, randomInt } from "crypto";
import { z } from "zod";
import { prisma, Tx, nextSeq, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { toMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal } from "@/server/ledger";
import { assertBranchAccess, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { createApproval } from "./approval-request";
import { computeFee } from "./fees";

/**
 * Virtual debit cards. NO real PAN is generated, stored or processed: we keep an
 * opaque token and a display mask built from a fictional BIN (999999) + random last4.
 * Real card issuing requires a PCI-DSS certified processor / scheme membership.
 */
const FICTIONAL_BIN = "999999";

export async function issueCardTx(tx: Tx, accountId: string, opts: { dailyLimit?: bigint; chargeFee?: boolean; staffId?: string; postedAt?: Date } = {}) {
  const acc = await tx.account.findUnique({ where: { id: accountId }, include: { customer: true } });
  if (!acc) throw Errors.notFound("Account");
  if (acc.type !== "CURRENT" && acc.type !== "SAVINGS") throw Errors.validation("Cards can only be linked to current/savings accounts");
  if (acc.status !== "ACTIVE") throw new AppError("ACCOUNT_NOT_ACTIVE", 422, "Account must be active");
  const n = await nextSeq(tx, "nb_card_seq");
  const last4 = String(randomInt(0, 10000)).padStart(4, "0");
  const now = opts.postedAt ?? new Date();
  const card = await tx.card.create({
    data: {
      customerId: acc.customerId, accountId: acc.id, token: `tok_${randomBytes(16).toString("hex")}`,
      maskedPan: `${FICTIONAL_BIN.slice(0, 4)} ${FICTIONAL_BIN.slice(4)}•• •••• ${last4}`, last4,
      holderName: acc.customer.nameEn.toUpperCase().slice(0, 26), expiryMonth: now.getUTCMonth() + 1, expiryYear: now.getUTCFullYear() + 4,
      dailyLimit: opts.dailyLimit ?? 2_000_000n, createdAt: now,
    },
  });
  if (opts.chargeFee !== false) {
    const { fee } = await computeFee(tx, "CARD_ISSUANCE", 0n, acc.currency);
    if (fee > 0n) {
      await postJournal(tx, {
        idempotencyKey: `card-fee:${card.id}`, type: "FEE", currency: acc.currency, channel: "SYSTEM", staffId: opts.staffId, branchId: acc.branchId,
        description: `Virtual card issuance fee (card ${n})`, postedAt: opts.postedAt,
        lines: [{ accountId: acc.id, debit: fee, narrative: "Card issuance fee" }, { glCode: GL.FEE_INCOME, credit: fee }],
      });
    }
  }
  return card;
}

export async function issueCard(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "card.manage");
  const { accountId, dailyLimit } = z.object({ accountId: z.string(), dailyLimit: z.string().optional() }).parse(raw);
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw Errors.notFound("Account");
  assertBranchAccess(staff, acc.branchId);
  return withTx(async (tx) => {
    const c = await issueCardTx(tx, accountId, { dailyLimit: dailyLimit ? toMinor(dailyLimit) : undefined, staffId: staff.id });
    await audit(actor, "CARD_ISSUED", { type: "Card", id: c.id }, undefined, { maskedPan: c.maskedPan }, tx);
    return c;
  });
}

const MAX_DAILY_LIMIT = 10_000_000n; // EGP 100,000

/** Customer self-service: freeze/unfreeze + limits. A BLOCKED card can't be unfrozen by the customer. */
export async function customerUpdateCard(customerId: string, actor: Actor, cardId: string, raw: unknown) {
  const input = z.object({ action: z.enum(["FREEZE", "UNFREEZE", "LIMITS"]), dailyLimit: z.string().optional(), onlineEnabled: z.boolean().optional() }).parse(raw);
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.customerId !== customerId) throw Errors.notFound("Card");
  if (card.status === "BLOCKED" || card.status === "CANCELLED") throw new AppError("CARD_BLOCKED", 422, "Card is blocked; contact the bank");
  const data: Record<string, unknown> = {};
  if (input.action === "FREEZE") data.status = "FROZEN";
  if (input.action === "UNFREEZE") data.status = "ACTIVE";
  if (input.action === "LIMITS") {
    if (input.dailyLimit) {
      const v = toMinor(input.dailyLimit);
      if (v > MAX_DAILY_LIMIT) throw Errors.validation("Daily limit exceeds the maximum of 100,000.00");
      data.dailyLimit = v;
    }
    if (input.onlineEnabled !== undefined) data.onlineEnabled = input.onlineEnabled;
  }
  const after = await prisma.card.update({ where: { id: cardId }, data });
  await audit(actor, `CARD_${input.action}`, { type: "Card", id: cardId }, { status: card.status, dailyLimit: card.dailyLimit, onlineEnabled: card.onlineEnabled }, { status: after.status, dailyLimit: after.dailyLimit, onlineEnabled: after.onlineEnabled });
  return after;
}

/** Staff: block immediately (e.g. fraud); unblocking needs maker-checker. */
export async function staffCardAction(staff: StaffPrincipal, actor: Actor, cardId: string, raw: unknown) {
  requirePerm(staff, "card.manage");
  const input = z.object({ action: z.enum(["BLOCK", "REQUEST_UNBLOCK", "CANCEL", "LIMITS"]), reason: z.string().max(200).optional(), dailyLimit: z.string().optional() }).parse(raw);
  const card = await prisma.card.findUnique({ where: { id: cardId }, include: { account: true } });
  if (!card) throw Errors.notFound("Card");
  assertBranchAccess(staff, card.account.branchId);
  if (input.action === "REQUEST_UNBLOCK") {
    if (card.status !== "BLOCKED") throw Errors.validation("Card is not blocked");
    return createApproval(prisma, actor, { type: "CARD_UNBLOCK", summary: `Unblock card ${card.maskedPan}: ${input.reason ?? ""}`, payload: { cardId }, makerId: staff.id, entityType: "Card", entityId: cardId, branchId: card.account.branchId });
  }
  const data: Record<string, unknown> = {};
  if (input.action === "BLOCK") Object.assign(data, { status: "BLOCKED", blockReason: input.reason ?? "Blocked by bank" });
  if (input.action === "CANCEL") data.status = "CANCELLED";
  if (input.action === "LIMITS" && input.dailyLimit) {
    const v = toMinor(input.dailyLimit);
    if (v > MAX_DAILY_LIMIT) throw Errors.validation("Limit too high");
    data.dailyLimit = v;
  }
  const after = await prisma.card.update({ where: { id: cardId }, data });
  await audit(actor, `CARD_${input.action}`, { type: "Card", id: cardId }, { status: card.status }, { status: after.status, reason: input.reason });
  return after;
}

export async function executeCardUnblock(payload: { cardId: string }, actor: Actor) {
  const card = await prisma.card.findUniqueOrThrow({ where: { id: payload.cardId } });
  if (card.status !== "BLOCKED") throw new AppError("INVALID_STATE", 409, "Card not blocked");
  const after = await prisma.card.update({ where: { id: card.id }, data: { status: "ACTIVE", blockReason: null } });
  await audit(actor, "CARD_UNBLOCKED", { type: "Card", id: card.id }, { status: "BLOCKED" }, { status: "ACTIVE" });
  return after;
}
