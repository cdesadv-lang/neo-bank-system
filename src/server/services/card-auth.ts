import { randomInt } from "crypto";
import { z } from "zod";
import type { Card, CardAuthorization, Currency, Prisma } from "@prisma/client";
import { prisma, Tx, nextSeq, withTx, isUniqueViolation } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { cairoDayStart, todayStr } from "@/lib/dates";
import { minorToString, toMinor } from "@/lib/money";
import { audit, SYSTEM_ACTOR, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal, reverseJournal, type LineInput } from "@/server/ledger";
import { getHsm } from "@/server/cards/hsm";
import { getThreeDs } from "@/server/cards/threeds";
import { requirePerm, type StaffPrincipal, assertBranchAccess, branchWhere } from "@/server/rbac";
import { planDispense, applyDispense, type DispensePlan } from "./atm";
import { computeFee } from "./fees";
import { notify } from "./notify";

export const OWN_ACQUIRER = "NEOBANK";
export const HOLD_DAYS = 7;
const APPROVED_STATES = ["AUTHORIZED", "CAPTURED", "COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"];

/** ISO 8583 DE 39 response codes used by this issuer. */
export const RESPONSE_CODES: Record<string, string> = {
  "00": "Approved", "05": "Do not honour", "13": "Invalid amount", "14": "Invalid card number", "51": "Insufficient funds",
  "54": "Expired card", "55": "Incorrect PIN", "57": "Transaction not permitted to cardholder", "61": "Exceeds withdrawal amount limit",
  "62": "Restricted card", "65": "Exceeds frequency limit / PIN required (contactless)", "68": "Response received too late", "75": "Allowable PIN tries exceeded",
  "91": "Issuer or switch inoperative", "1A": "Additional customer authentication required (3-D Secure)", "94": "Duplicate transmission",
};

export type Channel = "ATM" | "POS" | "ECOM" | "CONTACTLESS";
export type TxnType = "PURCHASE" | "CASH_WITHDRAWAL" | "BALANCE_INQUIRY" | "MINI_STATEMENT";

export type AuthRequest = {
  cardToken: string;
  channel: Channel;
  txnType: TxnType;
  amount: bigint;
  currency: Currency;
  stan: string;
  acquirerId?: string;
  terminalId?: string;
  merchant?: { name: string; id?: string; mcc?: string; country?: string };
  pinBlock?: string;
  threeDs?: { challengeId: string; code: string };
  entryMode?: string;
  postedAt?: Date;
};

export type AuthResponse = {
  approved: boolean;
  responseCode: string;
  message: string;
  rrn?: string;
  authCode?: string | null;
  authorizationId?: string;
  status?: string;
  availableBalance?: bigint;
  currency?: Currency;
  challengeId?: string;
  devCode?: string; // DEV/DEMO only (console OTP provider)
  dispensed?: DispensePlan | null;
  miniStatement?: { date: Date; description: string; debit: bigint; credit: bigint }[];
};

function respond(a: CardAuthorization, extra: Partial<AuthResponse> = {}): AuthResponse {
  return {
    approved: a.responseCode === "00", responseCode: a.responseCode, message: a.declineReason ?? RESPONSE_CODES[a.responseCode] ?? a.responseCode,
    rrn: a.rrn, authCode: a.authCode, authorizationId: a.id, status: a.status, currency: a.currency, dispensed: (a.dispensed as DispensePlan | null) ?? undefined, ...extra,
  };
}

async function newRrn(tx: Tx | typeof prisma): Promise<string> {
  const n = await nextSeq(tx, "nb_auth_seq");
  return `${todayStr().slice(2).replace(/-/g, "")}${String(n).padStart(6, "0")}`;
}

const channelLabel: Record<Channel, { ar: string; en: string }> = {
  ATM: { ar: "صراف آلي", en: "ATM" }, POS: { ar: "نقطة بيع", en: "POS" }, ECOM: { ar: "شراء عبر الإنترنت", en: "Online" }, CONTACTLESS: { ar: "دفع لا تلامسي", en: "Contactless" },
};

async function notifyCard(db: Tx | typeof prisma, customerId: string, kind: string, a: { channel: string; amount: bigint; currency: string; merchantName?: string | null; terminalId?: string | null }, extra = "") {
  const ch = channelLabel[a.channel as Channel] ?? { ar: a.channel, en: a.channel };
  const where = a.merchantName ?? a.terminalId ?? "";
  const amt = `${minorToString(a.amount)} ${a.currency}`;
  const T: Record<string, [string, string]> = {
    APPROVED: ["عملية بطاقة", "Card transaction"], DECLINED: ["عملية بطاقة مرفوضة", "Card transaction declined"], CAPTURED: ["تم تسوية عملية البطاقة", "Card transaction settled"],
    RELEASED: ["تم فك حجز مبلغ", "Card hold released"], REVERSED: ["تم عكس عملية البطاقة", "Card transaction reversed"], REFUNDED: ["استرداد على البطاقة", "Card refund received"],
    DISPUTE: ["تم فتح اعتراض", "Dispute opened"], CHARGEBACK: ["إضافة مؤقتة لاعتراض", "Provisional credit for dispute"], BLOCKED: ["تم إيقاف البطاقة", "Card blocked"],
  };
  const [tAr, tEn] = T[kind] ?? [kind, kind];
  await notify(db, customerId, { titleAr: tAr, titleEn: tEn, bodyAr: `${ch.ar} ${where} — ${amt} ${extra}`.trim(), bodyEn: `${ch.en} ${where} — ${amt} ${extra}`.trim() });
}

async function usedToday(cardId: string, channel?: Channel): Promise<bigint> {
  const r = await prisma.cardAuthorization.aggregate({
    where: { cardId, ...(channel ? { channel } : {}), status: { in: APPROVED_STATES }, txnType: { in: ["PURCHASE", "CASH_WITHDRAWAL"] }, createdAt: { gte: cairoDayStart() } },
    _sum: { amount: true },
  });
  return r._sum.amount ?? 0n;
}

function channelEnabled(card: Card, channel: Channel): boolean {
  return channel === "ATM" ? card.atmEnabled : channel === "POS" ? card.posEnabled : channel === "ECOM" ? card.onlineEnabled : card.contactlessEnabled;
}
function channelLimit(card: Card, channel: Channel): bigint {
  return channel === "ATM" ? card.atmDailyLimit : channel === "ECOM" ? card.ecomDailyLimit : card.posDailyLimit; // contactless counts toward POS
}

/**
 * Unified issuer authorization. Real-time effects:
 *  ATM (own terminal):   Dr customer / Cr ATM cash (cassettes decremented)          → COMPLETED
 *  ATM (other bank):     Dr customer / Cr scheme payable (+ fee to income)          → COMPLETED
 *  POS / ECOM / tap:     Dr customer / Cr card-authorization holds (funds held)     → AUTHORIZED, later CAPTURED / RELEASED
 */
export async function authorize(req: AuthRequest): Promise<AuthResponse> {
  const acquirerId = req.acquirerId ?? OWN_ACQUIRER;
  const key = `${acquirerId}:${req.terminalId ?? req.merchant?.id ?? "-"}:${req.stan}`;
  const existing = await prisma.cardAuthorization.findUnique({ where: { idempotencyKey: key } });
  if (existing && !(existing.status === "PENDING_3DS" && req.threeDs)) return respond(existing);

  const card = await prisma.card.findUnique({ where: { token: req.cardToken }, include: { account: true, customer: true } });
  if (!card) return { approved: false, responseCode: "14", message: RESPONSE_CODES["14"] };
  const acquirer = acquirerId === OWN_ACQUIRER ? "OWN" : "NETWORK";
  const financial = req.txnType === "PURCHASE" || req.txnType === "CASH_WITHDRAWAL";
  const base = {
    idempotencyKey: key, stan: req.stan, cardId: card.id, accountId: card.accountId, customerId: card.customerId, channel: req.channel, txnType: req.txnType, acquirer,
    amount: financial ? req.amount : 0n, currency: req.currency, merchantName: req.merchant?.name, merchantId: req.merchant?.id, mcc: req.merchant?.mcc,
    merchantCountry: req.merchant?.country ?? "EG", terminalId: req.terminalId, entryMode: req.entryMode, createdAt: req.postedAt,
  };

  const decline = async (code: string, reason?: string): Promise<AuthResponse> => {
    try {
      const row = existing
        ? await prisma.cardAuthorization.update({ where: { id: existing.id }, data: { status: "DECLINED", responseCode: code, declineReason: reason ?? RESPONSE_CODES[code] } })
        : await prisma.cardAuthorization.create({ data: { ...base, rrn: await newRrn(prisma), status: "DECLINED", responseCode: code, declineReason: reason ?? RESPONSE_CODES[code] } });
      await prisma.cardAuthEvent.create({ data: { authorizationId: row.id, type: "DECLINE", amount: base.amount, details: { code, reason } } });
      if (financial) await notifyCard(prisma, card.customerId, "DECLINED", base, `(${reason ?? RESPONSE_CODES[code]})`);
      return respond(row);
    } catch (e) {
      if (isUniqueViolation(e, "idempotencyKey")) return respond(await prisma.cardAuthorization.findUniqueOrThrow({ where: { idempotencyKey: key } }));
      throw e;
    }
  };

  // ---- card & cardholder checks
  if (card.status === "BLOCKED" || card.status === "CANCELLED") return decline("62", "Card blocked");
  if (card.status === "FROZEN") return decline("62", "Card frozen by cardholder");
  const now = req.postedAt ?? new Date();
  if (card.expiryYear < now.getUTCFullYear() || (card.expiryYear === now.getUTCFullYear() && card.expiryMonth < now.getUTCMonth() + 1)) return decline("54");
  if (!channelEnabled(card, req.channel)) return decline("57", `${req.channel} transactions disabled on this card`);
  if ((req.merchant?.country ?? "EG") !== "EG" && !card.internationalEnabled) return decline("57", "International use disabled");
  if (req.currency !== card.account.currency) return decline("57", "Currency not supported for this card");
  if (card.account.status !== "ACTIVE") return decline("05", `Account ${card.account.status}`);
  if (financial && req.amount <= 0n) return decline("13");

  // ---- cardholder verification: 3-D Secure for card-not-present, PIN for ATM/POS/high-value tap
  if (req.channel === "ECOM" && financial) {
    if (!req.threeDs) {
      const ch = await getThreeDs().challenge({ cardId: card.id, phone: card.customer.phone, merchantName: req.merchant?.name ?? "merchant", amount: minorToString(req.amount), currency: req.currency });
      const row = existing ?? await prisma.cardAuthorization.create({ data: { ...base, rrn: await newRrn(prisma), status: "PENDING_3DS", responseCode: "1A", threeDsChallengeId: ch.challengeId } });
      if (existing) await prisma.cardAuthorization.update({ where: { id: row.id }, data: { threeDsChallengeId: ch.challengeId } });
      await prisma.cardAuthEvent.create({ data: { authorizationId: row.id, type: "CHALLENGE", amount: base.amount } });
      return { ...respond(row), challengeId: ch.challengeId, devCode: ch.devCode };
    }
    if (!existing || existing.threeDsChallengeId !== req.threeDs.challengeId || !(await getThreeDs().verify(card.id, req.threeDs.challengeId, req.threeDs.code))) {
      return decline("05", "3-D Secure authentication failed");
    }
  }
  const pinRequired = req.channel === "ATM" || req.channel === "POS" || (req.channel === "CONTACTLESS" && req.amount > card.contactlessNoPinLimit);
  if (pinRequired) {
    if (!req.pinBlock) return decline(req.channel === "CONTACTLESS" ? "65" : "55", "PIN required");
    const ok = !!card.pinVerificationValue && getHsm().verifyPin(card.token, req.pinBlock, card.pinVerificationValue);
    if (!ok) {
      const tries = card.pinTries + 1;
      await prisma.card.update({ where: { id: card.id }, data: { pinTries: tries, ...(tries >= 3 ? { status: "BLOCKED", blockReason: "PIN tries exceeded" } : {}) } });
      if (tries >= 3) {
        await notifyCard(prisma, card.customerId, "BLOCKED", base, "(PIN)");
        return decline("75");
      }
      return decline("55");
    }
    if (card.pinTries) await prisma.card.update({ where: { id: card.id }, data: { pinTries: 0 } });
  }

  // ---- non-financial
  if (!financial) {
    const lines = req.txnType === "MINI_STATEMENT"
      ? (await prisma.journalLine.findMany({ where: { accountId: card.accountId }, include: { entry: true }, orderBy: { entry: { postedAt: "desc" } }, take: 10 })).map((l) => ({ date: l.entry.postedAt, description: (l.narrative ?? l.entry.description).slice(0, 40), debit: l.debit, credit: l.credit }))
      : undefined;
    const row = await prisma.cardAuthorization.create({ data: { ...base, rrn: await newRrn(prisma), status: "COMPLETED", responseCode: "00", authCode: String(randomInt(0, 1e6)).padStart(6, "0") } }).catch(async (e) => {
      if (isUniqueViolation(e, "idempotencyKey")) return prisma.cardAuthorization.findUniqueOrThrow({ where: { idempotencyKey: key } });
      throw e;
    });
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: card.accountId } });
    return respond(row, { availableBalance: acc.balance, miniStatement: lines });
  }

  // ---- limits
  const [dayAll, dayChannel] = await Promise.all([usedToday(card.id), usedToday(card.id, req.channel === "CONTACTLESS" ? "CONTACTLESS" : req.channel)]);
  const posBucket = req.channel === "POS" || req.channel === "CONTACTLESS" ? (await usedToday(card.id, "POS")) + (await usedToday(card.id, "CONTACTLESS")) : dayChannel;
  if (dayAll + req.amount > card.dailyLimit) return decline("61", "Card daily limit exceeded");
  if ((req.channel === "POS" || req.channel === "CONTACTLESS" ? posBucket : dayChannel) + req.amount > channelLimit(card, req.channel)) return decline("61", `${req.channel} daily limit exceeded`);

  let atm: (NonNullable<Awaited<ReturnType<typeof prisma.atmTerminal.findUnique>>> & { cassettes: { position: number; denomination: bigint; count: number }[] }) | null = null;
  if (req.channel === "ATM" && acquirer === "OWN") {
    atm = await prisma.atmTerminal.findUnique({ where: { terminalId: req.terminalId ?? "" }, include: { cassettes: true } });
    if (!atm) return decline("91", "Unknown terminal");
    if (atm.status !== "ONLINE") return decline("91", `ATM ${atm.status}`);
    if (req.amount > atm.maxWithdrawal) return decline("61", "Exceeds per-transaction ATM limit");
    if (!planDispense(atm.cassettes, req.amount)) return decline("13", "Amount cannot be dispensed with available notes");
  }

  // ---- post through the ledger (atomic with the authorization record)
  try {
    return await withTx(async (tx) => {
      const rrn = existing?.rrn ?? (await newRrn(tx));
      const authCode = String(randomInt(0, 1e6)).padStart(6, "0");
      let lines: LineInput[];
      let type: string;
      let status: string;
      let fee = 0n;
      let plan: DispensePlan | null = null;
      if (req.channel === "ATM") {
        type = "ATM_WITHDRAWAL";
        status = "COMPLETED";
        if (atm) {
          await tx.$queryRaw`SELECT id FROM "AtmTerminal" WHERE id = ${atm.id} FOR UPDATE`;
          const cas = await tx.atmCassette.findMany({ where: { atmId: atm.id } });
          plan = planDispense(cas, req.amount);
          if (!plan) throw new AppError("NOT_DISPENSABLE", 422, "Amount cannot be dispensed");
          lines = [{ accountId: card.accountId, debit: req.amount, narrative: `ATM ${atm.terminalId} ${atm.locationEn}` }, { tillId: atm.tillId, credit: req.amount, narrative: `ATM dispense RRN ${rrn}` }];
        } else {
          fee = (await computeFee(tx, "ATM_NETWORK_WITHDRAWAL", req.amount, req.currency)).fee;
          lines = [{ accountId: card.accountId, debit: req.amount, narrative: `ATM (other bank) ${req.terminalId ?? ""}` }, { glCode: GL.SCHEME_PAYABLE, credit: req.amount, narrative: `Network ATM RRN ${rrn}` }];
          if (fee > 0n) lines.push({ accountId: card.accountId, debit: fee, narrative: "Other-bank ATM fee" }, { glCode: GL.CARD_FEE_INCOME, credit: fee });
        }
      } else {
        type = "CARD_AUTH_HOLD";
        status = "AUTHORIZED";
        lines = [{ accountId: card.accountId, debit: req.amount, narrative: `Hold: ${req.merchant?.name ?? "merchant"} (${req.channel})` }, { glCode: GL.CARD_HOLDS, credit: req.amount, narrative: `Auth ${rrn}` }];
      }
      const { entry } = await postJournal(tx, {
        idempotencyKey: `card-auth:${key}`, type, currency: req.currency, channel: "API", branchId: card.account.branchId, customerId: card.customerId,
        description: `${req.channel} ${req.txnType} ${req.merchant?.name ?? req.terminalId ?? ""}`.trim(), reference: rrn, lines, postedAt: req.postedAt,
        metadata: { channel: req.channel, mcc: req.merchant?.mcc, merchantCountry: req.merchant?.country, terminalId: req.terminalId, stan: req.stan },
      });
      if (plan && atm) await applyDispense(tx, atm.id, plan, -1);
      const data = {
        ...base, rrn, authCode, status, responseCode: "00", feeAmount: fee, holdEntryId: entry.id, capturedAmount: status === "COMPLETED" ? req.amount : 0n,
        expiresAt: status === "AUTHORIZED" ? new Date(now.getTime() + HOLD_DAYS * 86400_000) : null, dispensed: plan ? JSON.parse(JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) : undefined,
      };
      const row = existing ? await tx.cardAuthorization.update({ where: { id: existing.id }, data }) : await tx.cardAuthorization.create({ data });
      await tx.cardAuthEvent.create({ data: { authorizationId: row.id, type: "AUTHORIZE", amount: req.amount, journalEntryId: entry.id } });
      await notifyCard(tx, card.customerId, "APPROVED", base);
      const acc = await tx.account.findUniqueOrThrow({ where: { id: card.accountId } });
      return respond(row, { availableBalance: acc.balance, dispensed: plan });
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const row = await prisma.cardAuthorization.findUnique({ where: { idempotencyKey: key } });
      if (row) return respond(row);
    }
    const code = (e as { code?: string }).code;
    if (code === "INSUFFICIENT_FUNDS") return decline("51");
    if (code === "ACCOUNT_FROZEN" || code === "ACCOUNT_DORMANT" || code === "ACCOUNT_CLOSED") return decline("62", code);
    if (code === "NOT_DISPENSABLE") return decline("13", "Amount cannot be dispensed");
    if (code === "TILL_INSUFFICIENT_CASH") return decline("91", "ATM cash position insufficient");
    throw e;
  }
}

async function lockAuth(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "CardAuthorization" WHERE id = ${id} FOR UPDATE`;
  const a = await tx.cardAuthorization.findUnique({ where: { id } });
  if (!a) throw Errors.notFound("Authorization");
  return a;
}

/** Capture/settle a held authorization (full or partial). Remainder of a partial capture is released. */
export async function capture(authId: string, amount?: bigint, opts: { postedAt?: Date } = {}) {
  return withTx(async (tx) => {
    const a = await lockAuth(tx, authId);
    if (a.status === "CAPTURED") return a;
    if (a.status !== "AUTHORIZED") throw new AppError("INVALID_STATE", 409, `Cannot capture a ${a.status} authorization`);
    const amt = amount ?? a.amount;
    if (amt <= 0n || amt > a.amount) throw Errors.validation("Capture amount must be > 0 and ≤ authorized amount");
    const lines: LineInput[] = [{ glCode: GL.CARD_HOLDS, debit: a.amount, narrative: `Capture ${a.rrn}` }, { glCode: GL.SCHEME_PAYABLE, credit: amt, narrative: `${a.merchantName ?? ""} settlement` }];
    if (amt < a.amount) lines.push({ accountId: a.accountId, credit: a.amount - amt, narrative: `Partial capture release ${a.rrn}` });
    const { entry } = await postJournal(tx, {
      idempotencyKey: `card-capture:${a.id}`, type: "CARD_CAPTURE", currency: a.currency, channel: "API", customerId: a.customerId, skipAml: true, overrideStatus: true,
      description: `Card capture ${a.merchantName ?? ""} RRN ${a.rrn}`, reference: a.rrn, lines, postedAt: opts.postedAt,
    });
    const after = await tx.cardAuthorization.update({ where: { id: a.id }, data: { status: "CAPTURED", capturedAmount: amt, captureEntryId: entry.id } });
    await tx.cardAuthEvent.create({ data: { authorizationId: a.id, type: "CAPTURE", amount: amt, journalEntryId: entry.id } });
    await notifyCard(tx, a.customerId, "CAPTURED", { ...a, amount: amt });
    return after;
  });
}

/** Release a hold (merchant void, expiry or reversal). Funds return to the customer immediately. */
export async function release(authId: string, reason: "VOID" | "EXPIRED" | "REVERSAL" = "VOID", opts: { postedAt?: Date } = {}) {
  return withTx(async (tx) => {
    const a = await lockAuth(tx, authId);
    if (a.status === "RELEASED" || a.status === "REVERSED") return a;
    if (a.status !== "AUTHORIZED") throw new AppError("INVALID_STATE", 409, `Cannot release a ${a.status} authorization`);
    const { entry } = await postJournal(tx, {
      idempotencyKey: `card-release:${a.id}`, type: "CARD_RELEASE", currency: a.currency, channel: "SYSTEM", customerId: a.customerId, skipAml: true, overrideStatus: true,
      description: `Release of hold ${a.rrn} (${reason})`, reference: a.rrn, postedAt: opts.postedAt,
      lines: [{ glCode: GL.CARD_HOLDS, debit: a.amount }, { accountId: a.accountId, credit: a.amount, narrative: `Hold released: ${a.merchantName ?? ""} (${reason})` }],
    });
    const status = reason === "REVERSAL" ? "REVERSED" : "RELEASED";
    const after = await tx.cardAuthorization.update({ where: { id: a.id }, data: { status, releaseEntryId: entry.id } });
    await tx.cardAuthEvent.create({ data: { authorizationId: a.id, type: reason === "REVERSAL" ? "REVERSE" : "RELEASE", amount: a.amount, journalEntryId: entry.id, details: { reason } } });
    await notifyCard(tx, a.customerId, status, a);
    return after;
  });
}

/** EOD: release holds that were never captured before expiry. */
export async function releaseExpiredHolds(now = new Date()) {
  const due = await prisma.cardAuthorization.findMany({ where: { status: "AUTHORIZED", expiresAt: { lte: now } }, select: { id: true } });
  for (const d of due) await release(d.id, "EXPIRED");
  return due.length;
}

/**
 * Reversal (ISO 8583 0400/0420). Works by original key so it is safe when the original
 * timed out: if the original never arrived, a tombstone makes a late original decline.
 */
export async function reverseByKey(input: { acquirerId?: string; terminalId?: string; merchantId?: string; stan: string; cardToken?: string; amount?: bigint; currency?: Currency; reason?: string }) {
  const key = `${input.acquirerId ?? OWN_ACQUIRER}:${input.terminalId ?? input.merchantId ?? "-"}:${input.stan}`;
  const a = await prisma.cardAuthorization.findUnique({ where: { idempotencyKey: key } });
  if (!a) {
    const card = input.cardToken ? await prisma.card.findUnique({ where: { token: input.cardToken } }) : null;
    if (!card) return { reversed: false, reason: "original not found" };
    const row = await prisma.cardAuthorization.create({
      data: {
        idempotencyKey: key, rrn: await newRrn(prisma), stan: input.stan, cardId: card.id, accountId: card.accountId, customerId: card.customerId, channel: "ATM", txnType: "CASH_WITHDRAWAL",
        acquirer: (input.acquirerId ?? OWN_ACQUIRER) === OWN_ACQUIRER ? "OWN" : "NETWORK", amount: input.amount ?? 0n, currency: input.currency ?? "EGP", terminalId: input.terminalId,
        status: "REVERSED", responseCode: "05", declineReason: "Reversed before original was processed (late original will be declined)",
      },
    }).catch(async (e) => { if (isUniqueViolation(e)) return prisma.cardAuthorization.findUniqueOrThrow({ where: { idempotencyKey: key } }); throw e; });
    return { reversed: true, tombstone: true, authorization: row };
  }
  return { reversed: true, authorization: await reverseAuthorization(a.id, input.reason ?? "REVERSAL") };
}

export async function reverseAuthorization(authId: string, reason = "REVERSAL") {
  const a0 = await prisma.cardAuthorization.findUniqueOrThrow({ where: { id: authId } });
  if (a0.status === "AUTHORIZED") return release(a0.id, "REVERSAL");
  return withTx(async (tx) => {
    const a = await lockAuth(tx, authId);
    if (a.status === "REVERSED" || a.status === "DECLINED" || a.status === "RELEASED") return a;
    if (a.status === "CAPTURED" || a.status === "REFUNDED" || a.status === "PARTIALLY_REFUNDED") throw new AppError("INVALID_STATE", 409, "Captured transactions are refunded, not reversed");
    if (a.status !== "COMPLETED") throw new AppError("INVALID_STATE", 409, `Cannot reverse ${a.status}`);
    let entryId: string | undefined;
    if (a.holdEntryId) {
      const r = await reverseJournal(tx, a.holdEntryId, { reason: `${reason} RRN ${a.rrn}` });
      entryId = r.entry.id;
      const atm = a.terminalId && a.acquirer === "OWN" ? await tx.atmTerminal.findUnique({ where: { terminalId: a.terminalId } }) : null;
      const plan = (a.dispensed as { position: number; denomination: string; notes: number }[] | null) ?? null;
      if (atm && plan) await applyDispense(tx, atm.id, plan.map((p) => ({ ...p, denomination: BigInt(p.denomination) })), 1);
    }
    const after = await tx.cardAuthorization.update({ where: { id: a.id }, data: { status: "REVERSED", reversalEntryId: entryId } });
    await tx.cardAuthEvent.create({ data: { authorizationId: a.id, type: "REVERSE", amount: a.amount, journalEntryId: entryId, details: { reason } } });
    if (a.amount > 0n) await notifyCard(tx, a.customerId, "REVERSED", a);
    return after;
  });
}

/** Merchant refund against a captured purchase: Dr scheme payable / Cr customer. */
export async function refund(authId: string, amount: bigint, opts: { idempotencyKey: string; postedAt?: Date }) {
  return withTx(async (tx) => {
    const a = await lockAuth(tx, authId);
    if (a.status !== "CAPTURED" && a.status !== "PARTIALLY_REFUNDED") throw new AppError("INVALID_STATE", 409, "Only captured purchases can be refunded");
    if (amount <= 0n || a.refundedAmount + amount > a.capturedAmount) throw Errors.validation("Refund exceeds captured amount");
    const prior = await tx.journalEntry.findUnique({ where: { idempotencyKey: `card-refund:${a.id}:${opts.idempotencyKey}` } });
    if (prior) return a;
    const { entry } = await postJournal(tx, {
      idempotencyKey: `card-refund:${a.id}:${opts.idempotencyKey}`, type: "CARD_REFUND", currency: a.currency, channel: "API", customerId: a.customerId, skipAml: true, overrideStatus: true,
      description: `Refund from ${a.merchantName ?? "merchant"} RRN ${a.rrn}`, reference: a.rrn, postedAt: opts.postedAt,
      lines: [{ glCode: GL.SCHEME_PAYABLE, debit: amount }, { accountId: a.accountId, credit: amount, narrative: `Refund: ${a.merchantName ?? ""}` }],
    });
    const refunded = a.refundedAmount + amount;
    const after = await tx.cardAuthorization.update({ where: { id: a.id }, data: { refundedAmount: refunded, status: refunded === a.capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
    await tx.cardAuthEvent.create({ data: { authorizationId: a.id, type: "REFUND", amount, journalEntryId: entry.id } });
    await notifyCard(tx, a.customerId, "REFUNDED", { ...a, amount });
    return after;
  });
}

// ---------------- disputes ----------------
const disputeInput = z.object({ authorizationId: z.string(), reason: z.enum(["NOT_RECOGNISED", "CASH_NOT_DISPENSED", "DUPLICATE", "GOODS_NOT_RECEIVED", "WRONG_AMOUNT", "OTHER"]), description: z.string().max(1000).optional() });

async function openDispute(input: z.infer<typeof disputeInput>, openedBy: "CUSTOMER" | "STAFF", actor: Actor) {
  const a = await prisma.cardAuthorization.findUnique({ where: { id: input.authorizationId }, include: { disputes: true } });
  if (!a) throw Errors.notFound("Card transaction");
  if (!["COMPLETED", "CAPTURED", "PARTIALLY_REFUNDED"].includes(a.status) || a.amount === 0n) throw Errors.validation("This transaction cannot be disputed");
  if (a.disputes.some((d) => !["REJECTED", "RESOLVED_MERCHANT"].includes(d.status))) throw Errors.conflict("A dispute is already open");
  const n = await nextSeq(prisma, "nb_dispute_seq");
  const d = await prisma.cardDispute.create({
    data: { disputeNo: `DSP-${String(n).padStart(6, "0")}`, authorizationId: a.id, customerId: a.customerId, reason: input.reason, description: input.description, amount: a.capturedAmount - a.refundedAmount, openedBy },
  });
  await prisma.cardAuthEvent.create({ data: { authorizationId: a.id, type: "DISPUTE", amount: d.amount, details: { disputeNo: d.disputeNo, reason: d.reason } } });
  await notifyCard(prisma, a.customerId, "DISPUTE", { ...a, amount: d.amount }, d.disputeNo);
  await audit(actor, "CARD_DISPUTE_OPENED", { type: "CardDispute", id: d.id }, undefined, d);
  return d;
}

export async function openDisputeByCustomer(customerId: string, actor: Actor, raw: unknown) {
  const input = disputeInput.parse(raw);
  const a = await prisma.cardAuthorization.findUnique({ where: { id: input.authorizationId } });
  if (!a || a.customerId !== customerId) throw Errors.notFound("Card transaction");
  return openDispute(input, "CUSTOMER", actor);
}

export async function openDisputeByStaff(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "card.dispute");
  return openDispute(disputeInput.parse(raw), "STAFF", actor);
}

export async function listDisputes(staff: StaffPrincipal) {
  requirePerm(staff, "card.read");
  return prisma.cardDispute.findMany({ where: { authorization: { card: { account: branchWhere(staff) } } }, include: { authorization: { include: { card: { select: { maskedPan: true, customer: { select: { nameEn: true, nameAr: true, cif: true, branchId: true } } } } } } }, orderBy: { createdAt: "desc" }, take: 200 });
}

/**
 * Dispute workflow:
 *  CHARGEBACK        provisional credit to customer (Dr scheme receivable / Cr customer) — card-network disputes
 *  RESOLVE_CUSTOMER  chargeback won: scheme pays (Dr settlement / Cr scheme receivable); own-ATM "cash not dispensed": original reversed
 *  RESOLVE_MERCHANT  chargeback lost: provisional credit taken back (Dr customer / Cr scheme receivable)
 *  REJECT            dispute rejected without financial impact
 */
export async function disputeAction(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "card.dispute");
  const { action, note } = z.object({ action: z.enum(["CHARGEBACK", "RESOLVE_CUSTOMER", "RESOLVE_MERCHANT", "REJECT"]), note: z.string().max(500).optional() }).parse(raw);
  const d = await prisma.cardDispute.findUnique({ where: { id }, include: { authorization: { include: { card: { include: { account: true } } } } } });
  if (!d) throw Errors.notFound("Dispute");
  assertBranchAccess(staff, d.authorization.card.account.branchId);
  const a = d.authorization;
  if (action === "REJECT") {
    if (d.status !== "OPEN") throw new AppError("INVALID_STATE", 409, "Only open disputes can be rejected");
    const r = await prisma.cardDispute.update({ where: { id }, data: { status: "REJECTED", resolvedById: staff.id, resolvedAt: new Date() } });
    await audit(actor, "CARD_DISPUTE_REJECTED", { type: "CardDispute", id }, { status: d.status }, { status: r.status, note });
    return r;
  }
  if (action === "RESOLVE_CUSTOMER" && d.status === "OPEN" && a.channel === "ATM" && a.acquirer === "OWN") {
    // cash-not-dispensed at our own ATM: confirmed by ATM reconciliation → reverse the withdrawal
    const r = await reverseAuthorization(a.id, `Dispute ${d.disputeNo} resolved`);
    const out = await prisma.cardDispute.update({ where: { id }, data: { status: "RESOLVED_CUSTOMER", resolvedById: staff.id, resolvedAt: new Date(), resolutionEntryId: r.reversalEntryId } });
    await audit(actor, "CARD_DISPUTE_RESOLVED", { type: "CardDispute", id }, { status: d.status }, { status: out.status, note });
    return out;
  }
  return withTx(async (tx) => {
    let entryId: string | undefined;
    let status: string;
    if (action === "CHARGEBACK") {
      if (d.status !== "OPEN") throw new AppError("INVALID_STATE", 409, "Dispute not open");
      const { entry } = await postJournal(tx, {
        idempotencyKey: `chargeback:${d.id}`, type: "CHARGEBACK", currency: a.currency, channel: "BRANCH", staffId: staff.id, skipAml: true, overrideStatus: true,
        description: `Chargeback ${d.disputeNo} provisional credit`, reference: d.disputeNo,
        lines: [{ glCode: GL.SCHEME_RECEIVABLE, debit: d.amount }, { accountId: a.accountId, credit: d.amount, narrative: `Provisional credit ${d.disputeNo}` }],
      });
      entryId = entry.id;
      status = "CHARGEBACK_RAISED";
      await notifyCard(tx, a.customerId, "CHARGEBACK", { ...a, amount: d.amount }, d.disputeNo);
      await tx.cardDispute.update({ where: { id }, data: { status, provisionalEntryId: entryId } });
    } else {
      if (d.status !== "CHARGEBACK_RAISED") throw new AppError("INVALID_STATE", 409, "Raise a chargeback first");
      const { entry } = await postJournal(tx, {
        idempotencyKey: `chargeback-resolve:${d.id}`, type: "CHARGEBACK", currency: a.currency, channel: "BRANCH", staffId: staff.id, skipAml: true, overrideStatus: true,
        description: `Chargeback ${d.disputeNo} ${action === "RESOLVE_CUSTOMER" ? "won (scheme settlement)" : "lost (provisional credit reversed)"}`, reference: d.disputeNo,
        lines: action === "RESOLVE_CUSTOMER"
          ? [{ glCode: GL.DUE_FROM_CBE, debit: d.amount }, { glCode: GL.SCHEME_RECEIVABLE, credit: d.amount }]
          : [{ accountId: a.accountId, debit: d.amount, narrative: `Dispute ${d.disputeNo} decided for merchant` }, { glCode: GL.SCHEME_RECEIVABLE, credit: d.amount }],
      });
      entryId = entry.id;
      status = action === "RESOLVE_CUSTOMER" ? "RESOLVED_CUSTOMER" : "RESOLVED_MERCHANT";
      await tx.cardDispute.update({ where: { id }, data: { status, resolutionEntryId: entryId, resolvedById: staff.id, resolvedAt: new Date() } });
    }
    await tx.cardAuthEvent.create({ data: { authorizationId: a.id, type: "CHARGEBACK", amount: d.amount, journalEntryId: entryId, details: { action, disputeNo: d.disputeNo } } });
    await audit(actor, `CARD_DISPUTE_${action}`, { type: "CardDispute", id }, { status: d.status }, { status, note }, tx);
    return tx.cardDispute.findUniqueOrThrow({ where: { id } });
  });
}

// ---------------- staff operations on authorizations ----------------
export async function staffAuthAction(staff: StaffPrincipal, actor: Actor, authId: string, raw: unknown) {
  requirePerm(staff, "card.manage");
  const input = z.object({ action: z.enum(["CAPTURE", "RELEASE", "REVERSE", "REFUND"]), amount: z.string().optional(), idempotencyKey: z.string().optional() }).parse(raw);
  const a = await prisma.cardAuthorization.findUnique({ where: { id: authId }, include: { card: { include: { account: true } } } });
  if (!a) throw Errors.notFound("Authorization");
  assertBranchAccess(staff, a.card.account.branchId);
  let r: unknown;
  if (input.action === "CAPTURE") r = await capture(authId, input.amount ? toMinor(input.amount) : undefined);
  else if (input.action === "RELEASE") r = await release(authId, "VOID");
  else if (input.action === "REVERSE") r = await reverseAuthorization(authId, "Staff reversal");
  else r = await refund(authId, toMinor(input.amount ?? "0"), { idempotencyKey: input.idempotencyKey ?? `staff-${Date.now()}` });
  await audit(actor, `CARD_AUTH_${input.action}`, { type: "CardAuthorization", id: authId }, { status: a.status }, r);
  return r;
}

export async function setCardPin(cardId: string, pinBlock: string, actor: Actor = SYSTEM_ACTOR) {
  const card = await prisma.card.findUniqueOrThrow({ where: { id: cardId } });
  const pvv = getHsm().generatePvv(card.token, pinBlock);
  await prisma.card.update({ where: { id: cardId }, data: { pinVerificationValue: pvv, pinTries: 0 } });
  await audit(actor, "CARD_PIN_SET", { type: "Card", id: cardId });
}

export type CardAuthRow = CardAuthorization;
export type CardAuthWhere = Prisma.CardAuthorizationWhereInput;
