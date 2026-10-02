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

/** Customer self-service: freeze/unfreeze, per-channel toggles and limits, PIN set. A BLOCKED card can't be unfrozen by the customer. */
export const cardSettingsInput = z.object({
  action: z.enum(["FREEZE", "UNFREEZE", "SETTINGS", "SET_PIN"]),
  atmEnabled: z.boolean().optional(),
  posEnabled: z.boolean().optional(),
  onlineEnabled: z.boolean().optional(),
  contactlessEnabled: z.boolean().optional(),
  internationalEnabled: z.boolean().optional(),
  dailyLimit: z.string().optional(),
  atmDailyLimit: z.string().optional(),
  posDailyLimit: z.string().optional(),
  ecomDailyLimit: z.string().optional(),
  contactlessNoPinLimit: z.string().optional(),
  pin: z.string().regex(/^\d{4}$/).optional(),
});
const LIMIT_CAPS: Record<string, bigint> = { dailyLimit: MAX_DAILY_LIMIT, atmDailyLimit: 3_000_000n, posDailyLimit: MAX_DAILY_LIMIT, ecomDailyLimit: 5_000_000n, contactlessNoPinLimit: 100_000n };

export async function customerUpdateCard(customerId: string, actor: Actor, cardId: string, raw: unknown) {
  const input = cardSettingsInput.parse(raw);
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.customerId !== customerId) throw Errors.notFound("Card");
  if (card.status === "BLOCKED" || card.status === "CANCELLED") throw new AppError("CARD_BLOCKED", 422, "Card is blocked; contact the bank");
  if (input.action === "SET_PIN") {
    if (!input.pin || /^(\d)\1{3}$/.test(input.pin) || ["1234", "4321", "0000"].includes(input.pin)) throw Errors.validation("Choose a less predictable 4-digit PIN");
    const { getHsm } = await import("@/server/cards/hsm");
    // The PIN is encrypted into a PIN block immediately and only the HSM-derived PVV is stored.
    const hsm = getHsm();
    await prisma.card.update({ where: { id: cardId }, data: { pinVerificationValue: hsm.generatePvv(card.token, hsm.encryptPinBlock(input.pin, card.token)), pinTries: 0 } });
    await audit(actor, "CARD_PIN_SET", { type: "Card", id: cardId });
    return { ok: true };
  }
  const data: Record<string, unknown> = {};
  if (input.action === "FREEZE") data.status = "FROZEN";
  if (input.action === "UNFREEZE") data.status = "ACTIVE";
  if (input.action === "SETTINGS") {
    for (const k of ["atmEnabled", "posEnabled", "onlineEnabled", "contactlessEnabled", "internationalEnabled"] as const) if (input[k] !== undefined) data[k] = input[k];
    for (const k of ["dailyLimit", "atmDailyLimit", "posDailyLimit", "ecomDailyLimit", "contactlessNoPinLimit"] as const) {
      if (input[k] === undefined) continue;
      const v = toMinor(input[k]!);
      if (v > LIMIT_CAPS[k]) throw Errors.validation(`${k} exceeds the maximum allowed`);
      data[k] = v;
    }
  }
  const pick = (c: typeof card) => ({ status: c.status, dailyLimit: c.dailyLimit, atm: c.atmEnabled, pos: c.posEnabled, ecom: c.onlineEnabled, contactless: c.contactlessEnabled, intl: c.internationalEnabled, atmLimit: c.atmDailyLimit, posLimit: c.posDailyLimit, ecomLimit: c.ecomDailyLimit });
  const after = await prisma.card.update({ where: { id: cardId }, data });
  await audit(actor, `CARD_${input.action}`, { type: "Card", id: cardId }, pick(card), pick(after));
  return { ...after, token: undefined, pinVerificationValue: undefined };
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
