import { z } from "zod";
import { prisma, Tx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { audit, type Actor } from "@/server/audit";
import { getCounterDriver } from "@/server/devices/cash-counter";
import { assertBranchAccess, branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";

export async function listDevices(staff: StaffPrincipal) {
  requirePerm(staff, "till.read");
  return prisma.cashCounterDevice.findMany({ where: branchWhere(staff), orderBy: { deviceId: "asc" }, include: { sessions: { orderBy: { createdAt: "desc" }, take: 5 } } });
}

const regInput = z.object({ deviceId: z.string().regex(/^[A-Z0-9-]{3,32}$/), branchId: z.string(), model: z.string().min(2), driver: z.enum(["SIMULATOR", "SERIAL", "USB", "TCP"]), address: z.string().optional() });

export async function registerDevice(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.manage");
  const input = regInput.parse(raw);
  assertBranchAccess(staff, input.branchId);
  const d = await prisma.cashCounterDevice.create({ data: input });
  await audit(actor, "COUNTER_REGISTERED", { type: "CashCounterDevice", id: d.id }, undefined, d);
  return d;
}

const countInput = z.object({
  deviceId: z.string(),
  purpose: z.enum(["DEPOSIT", "WITHDRAWAL", "TILL_BALANCING", "VAULT", "ATM_REPLENISH", "ATM_EOD"]),
  tillId: z.string().optional(),
  currency: z.enum(["EGP", "USD", "EUR", "SAR"]).default("EGP"),
  simulate: z.object({ denominations: z.record(z.string(), z.coerce.number().int().min(0)).optional(), counterfeits: z.coerce.number().int().min(0).optional() }).optional(),
});

/** Ask the device (via its driver) to count, and persist the result as a count session. */
export async function captureCount(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.operate");
  const input = countInput.parse(raw);
  const device = await prisma.cashCounterDevice.findUnique({ where: { deviceId: input.deviceId } });
  if (!device) throw Errors.notFound("Cash counter");
  assertBranchAccess(staff, device.branchId);
  if (device.status !== "ONLINE") throw new AppError("DEVICE_OFFLINE", 422, "Device is offline");
  const driver = getCounterDriver(device);
  const result = await driver.count({ currency: input.currency, simulate: input.simulate });
  const s = await prisma.cashCountSession.create({
    data: {
      deviceId: device.id, staffId: staff.id, tillId: input.tillId, currency: result.currency, purpose: input.purpose,
      denominations: result.denominations, total: result.total, noteCount: result.noteCount, suspectedCounterfeits: result.suspectedCounterfeits, serials: result.serials,
    },
  });
  await audit(actor, "CASH_COUNTED", { type: "CashCountSession", id: s.id }, undefined, { device: device.deviceId, total: s.total, counterfeits: s.suspectedCounterfeits, purpose: s.purpose });
  return s;
}

/**
 * Bind a count session to a cash operation (single use, same staff, recent, matching currency/amount).
 * Deposits with suspected counterfeit notes are refused: the notes must be retained & reported.
 */
export async function consumeCountSession(tx: Tx, id: string, staff: StaffPrincipal, opts: { expectedTotal?: bigint; purpose: string; currency: string; ref?: string }) {
  const s = await tx.cashCountSession.findUnique({ where: { id } });
  if (!s) throw Errors.notFound("Count session");
  if (s.staffId !== staff.id) throw Errors.forbidden("Count session belongs to another user");
  if (s.usedAt) throw new AppError("COUNT_ALREADY_USED", 409, "Count session already used");
  if (Date.now() - s.createdAt.getTime() > 30 * 60_000) throw new AppError("COUNT_EXPIRED", 422, "Count session expired; recount");
  if (s.currency !== opts.currency) throw new AppError("CURRENCY_MISMATCH", 422, "Count currency mismatch");
  if (s.suspectedCounterfeits > 0 && (opts.purpose === "DEPOSIT" || opts.purpose === "ATM_REPLENISH")) throw new AppError("COUNTERFEIT_SUSPECTED", 422, `${s.suspectedCounterfeits} suspected counterfeit note(s) — retain and report`);
  if (opts.expectedTotal !== undefined && s.total !== opts.expectedTotal) throw new AppError("COUNT_MISMATCH", 422, `Counted ${s.total} ≠ expected ${opts.expectedTotal}`);
  const r = await tx.cashCountSession.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date(), usedRef: opts.ref ?? opts.purpose } });
  if (r.count !== 1) throw new AppError("COUNT_ALREADY_USED", 409, "Count session already used");
  return s;
}
