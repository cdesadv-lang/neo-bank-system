import { z } from "zod";
import type { AtmCassette } from "@prisma/client";
import { prisma, Tx, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { dateOnly, todayStr } from "@/lib/dates";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal } from "@/server/ledger";
import { assertBranchAccess, branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { consumeCountSession } from "./cash-count";

export type DispensePlan = { position: number; denomination: bigint; notes: number }[];

/** Choose notes to dispense (fewest notes, respects cassette availability). Returns null if impossible. */
export function planDispense(cassettes: Pick<AtmCassette, "position" | "denomination" | "count">[], amount: bigint): DispensePlan | null {
  const cs = [...cassettes].filter((c) => c.count > 0).sort((a, b) => Number(b.denomination - a.denomination));
  const MAX_NOTES = 60; // typical presenter capacity
  const best: { plan: DispensePlan | null; notes: number } = { plan: null, notes: Infinity };
  const walk = (i: number, rest: bigint, acc: DispensePlan, used: number) => {
    if (rest === 0n) {
      if (used < best.notes) { best.plan = acc.filter((p) => p.notes > 0).map((p) => ({ ...p })); best.notes = used; }
      return;
    }
    if (i >= cs.length || used >= best.notes || used > MAX_NOTES) return;
    const c = cs[i];
    const maxN = Math.min(c.count, Number(rest / c.denomination), MAX_NOTES - used);
    for (let n = maxN; n >= 0; n--) {
      acc.push({ position: c.position, denomination: c.denomination, notes: n });
      walk(i + 1, rest - c.denomination * BigInt(n), acc, used + n);
      acc.pop();
      if (best.plan && n < maxN - 3) break; // bounded search
    }
  };
  walk(0, amount, [], 0);
  return best.plan;
}

export function cassetteTotal(cassettes: Pick<AtmCassette, "denomination" | "count">[]): bigint {
  return cassettes.reduce((s, c) => s + c.denomination * BigInt(c.count), 0n);
}

export async function listAtms(staff: StaffPrincipal) {
  requirePerm(staff, "atm.read");
  const atms = await prisma.atmTerminal.findMany({ where: branchWhere(staff), include: { branch: true, cassettes: { orderBy: { position: "asc" } }, reconciliations: { orderBy: { createdAt: "desc" }, take: 3 } }, orderBy: { terminalId: "asc" } });
  const tills = await prisma.till.findMany({ where: { id: { in: atms.map((a) => a.tillId) } } });
  return atms.map((a) => ({ ...a, till: tills.find((t) => t.id === a.tillId)!, cassetteBalance: cassetteTotal(a.cassettes) }));
}

const createInput = z.object({
  terminalId: z.string().regex(/^[A-Z0-9]{8}$/, "Terminal id must be 8 uppercase alphanumerics"),
  branchId: z.string(),
  locationAr: z.string().min(2),
  locationEn: z.string().min(2),
  denominations: z.array(z.coerce.number().int().positive()).min(1).max(4).default([20000, 10000, 5000, 2000]),
});

export async function createAtm(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "atm.manage");
  const input = createInput.parse(raw);
  assertBranchAccess(staff, input.branchId);
  return withTx(async (tx) => {
    const till = await tx.till.create({ data: { code: `ATM-${input.terminalId}`, branchId: input.branchId, kind: "ATM", currency: "EGP", status: "OPEN" } });
    const atm = await tx.atmTerminal.create({
      data: {
        terminalId: input.terminalId, branchId: input.branchId, locationAr: input.locationAr, locationEn: input.locationEn, tillId: till.id,
        cassettes: { create: input.denominations.map((d, i) => ({ position: i + 1, denomination: BigInt(d), count: 0 })) },
      },
    });
    await audit(actor, "ATM_CREATED", { type: "AtmTerminal", id: atm.id }, undefined, atm, tx);
    return atm;
  });
}

export async function setAtmStatus(staff: StaffPrincipal, actor: Actor, atmId: string, status: string) {
  requirePerm(staff, "atm.manage");
  if (!["ONLINE", "OFFLINE", "OUT_OF_SERVICE", "MAINTENANCE"].includes(status)) throw Errors.validation("bad status");
  const atm = await prisma.atmTerminal.findUnique({ where: { id: atmId } });
  if (!atm) throw Errors.notFound("ATM");
  assertBranchAccess(staff, atm.branchId);
  const after = await prisma.atmTerminal.update({ where: { id: atmId }, data: { status } });
  await audit(actor, "ATM_STATUS", { type: "AtmTerminal", id: atmId }, { status: atm.status }, { status });
  return after;
}

const replenishInput = z.object({
  atmId: z.string(),
  cassettes: z.array(z.object({ position: z.coerce.number().int(), notes: z.coerce.number().int().min(0).max(5000) })).min(1),
  countSessionId: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

/** Load notes from the branch vault into cassettes: Dr ATM cash / Cr Vault cash. */
export async function replenishAtm(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "atm.manage");
  const input = replenishInput.parse(raw);
  return withTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AtmTerminal" WHERE id = ${input.atmId} FOR UPDATE`;
    const atm = await tx.atmTerminal.findUnique({ where: { id: input.atmId }, include: { cassettes: true } });
    if (!atm) throw Errors.notFound("ATM");
    assertBranchAccess(staff, atm.branchId);
    const vault = await tx.till.findFirst({ where: { branchId: atm.branchId, kind: "VAULT", currency: atm.currency } });
    if (!vault) throw new AppError("NO_VAULT", 422, "Branch vault not found");
    let amount = 0n;
    for (const c of input.cassettes) {
      const cas = atm.cassettes.find((x) => x.position === c.position);
      if (!cas) throw Errors.validation(`No cassette at position ${c.position}`);
      amount += cas.denomination * BigInt(c.notes);
    }
    if (amount <= 0n) throw Errors.validation("Nothing to load");
    if (input.countSessionId) await consumeCountSession(tx, input.countSessionId, staff, { expectedTotal: amount, purpose: "ATM_REPLENISH", currency: atm.currency });
    const { entry, replayed } = await postJournal(tx, {
      idempotencyKey: `atm-replenish:${atm.id}:${input.idempotencyKey}`, type: "TILL_TRANSFER", currency: atm.currency, channel: "BRANCH", branchId: atm.branchId, staffId: staff.id,
      description: `ATM ${atm.terminalId} replenishment`, lines: [{ tillId: atm.tillId, debit: amount }, { tillId: vault.id, credit: amount }],
    });
    if (replayed) return { entry, replayed };
    for (const c of input.cassettes) {
      await tx.atmCassette.update({ where: { atmId_position: { atmId: atm.id, position: c.position } }, data: { count: { increment: c.notes } } });
    }
    const cassettes = await tx.atmCassette.findMany({ where: { atmId: atm.id } });
    const till = await tx.till.findUniqueOrThrow({ where: { id: atm.tillId } });
    await tx.atmTerminal.update({ where: { id: atm.id }, data: { lastReplenishedAt: new Date() } });
    await tx.atmReconciliation.create({ data: { atmId: atm.id, businessDate: dateOnly(todayStr()), kind: "REPLENISHMENT", systemBalance: till.balance, cassetteBalance: cassetteTotal(cassettes), staffId: staff.id, countSessionId: input.countSessionId, details: { loaded: input.cassettes, amount: amount.toString() } } });
    await audit(actor, "ATM_REPLENISHED", { type: "AtmTerminal", id: atm.id }, undefined, { amount, entry: entry.entryNo }, tx);
    return { entry, replayed: false, amount };
  });
}

const reconcileInput = z.object({
  atmId: z.string(),
  counted: z.array(z.object({ position: z.coerce.number().int(), notes: z.coerce.number().int().min(0) })).optional(),
  countSessionId: z.string().optional(),
});

/**
 * ATM EOD / cash-out reconciliation. Compares:
 *   system balance (ATM till per ledger) vs cassette counters vs physical count.
 * Physical variance is booked to Cash Over/Short and cassette counters are reset to the count.
 */
export async function reconcileAtm(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "atm.manage");
  const input = reconcileInput.parse(raw);
  return withTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AtmTerminal" WHERE id = ${input.atmId} FOR UPDATE`;
    const atm = await tx.atmTerminal.findUnique({ where: { id: input.atmId }, include: { cassettes: true } });
    if (!atm) throw Errors.notFound("ATM");
    assertBranchAccess(staff, atm.branchId);
    const till = await tx.till.findUniqueOrThrow({ where: { id: atm.tillId } });
    const cassetteBalance = cassetteTotal(atm.cassettes);
    let counted: bigint | null = null;
    if (input.counted) {
      counted = 0n;
      for (const c of input.counted) {
        const cas = atm.cassettes.find((x) => x.position === c.position);
        if (!cas) throw Errors.validation(`No cassette ${c.position}`);
        counted += cas.denomination * BigInt(c.notes);
      }
    } else if (input.countSessionId) {
      const s = await consumeCountSession(tx, input.countSessionId, staff, { purpose: "ATM_EOD", currency: atm.currency });
      counted = s.total;
    }
    const physical = counted ?? cassetteBalance;
    const variance = physical - till.balance;
    let varianceEntryId: string | undefined;
    if (variance !== 0n) {
      const abs = variance < 0n ? -variance : variance;
      const { entry } = await postJournal(tx, {
        idempotencyKey: `atm-variance:${atm.id}:${Date.now()}`, type: "CASH_VARIANCE", currency: atm.currency, channel: "BRANCH", branchId: atm.branchId, staffId: staff.id,
        description: `ATM ${atm.terminalId} ${variance > 0n ? "overage" : "shortage"} at reconciliation`,
        lines: variance > 0n ? [{ tillId: atm.tillId, debit: abs }, { glCode: GL.CASH_OVER_SHORT, credit: abs }] : [{ glCode: GL.CASH_OVER_SHORT, debit: abs }, { tillId: atm.tillId, credit: abs }],
      });
      varianceEntryId = entry.id;
    }
    if (input.counted) {
      for (const c of input.counted) await tx.atmCassette.update({ where: { atmId_position: { atmId: atm.id, position: c.position } }, data: { count: c.notes } });
    }
    const rec = await tx.atmReconciliation.create({
      data: { atmId: atm.id, businessDate: dateOnly(todayStr()), kind: "EOD", systemBalance: till.balance, cassetteBalance, countedBalance: counted, variance, countSessionId: input.countSessionId, staffId: staff.id, varianceEntryId },
    });
    await audit(actor, "ATM_RECONCILED", { type: "AtmTerminal", id: atm.id }, { system: till.balance, cassettes: cassetteBalance }, { counted, variance }, tx);
    return rec;
  });
}

/** Dispense bookkeeping (used by the card authorization engine inside its transaction). */
export async function applyDispense(tx: Tx, atmId: string, plan: DispensePlan, sign: 1 | -1) {
  for (const p of plan) {
    await tx.atmCassette.update({ where: { atmId_position: { atmId, position: p.position } }, data: { count: { increment: sign * p.notes } } });
  }
}
