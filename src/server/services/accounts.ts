import { z } from "zod";
import type { AccountStatus, AccountType, Currency, Prisma } from "@prisma/client";
import { prisma, Tx, nextSeq, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { makeIban } from "@/lib/iban";
import { audit, type Actor } from "@/server/audit";
import { glForAccountType } from "@/server/gl";
import { assertBranchAccess, branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { createApproval } from "./approval-request";
import { notify } from "./notify";

/** Default annual interest (basis points) for savings accounts by currency. */
export const SAVINGS_RATES: Record<Currency, number> = { EGP: 1500, USD: 300, EUR: 200, SAR: 250 };

export async function createAccountRow(
  tx: Tx,
  input: { customerId: string; type: AccountType; currency: Currency; nickname?: string; interestRateBps?: number; openedById?: string; forceStatus?: AccountStatus; openedAt?: Date },
) {
  const customer = await tx.customer.findUnique({ where: { id: input.customerId }, include: { branch: true } });
  if (!customer) throw Errors.notFound("Customer");
  if (customer.status !== "ACTIVE") throw new AppError("CUSTOMER_INACTIVE", 422, "Customer is not active");
  if (customer.kycStatus === "REJECTED") throw new AppError("KYC_REJECTED", 422, "Customer KYC rejected");
  const gl = await tx.glAccount.findUniqueOrThrow({ where: { code: glForAccountType(input.type) } });
  const serial = await nextSeq(tx, "nb_account_seq");
  const status: AccountStatus = input.forceStatus ?? (customer.kycStatus === "APPROVED" ? "ACTIVE" : "PENDING");
  return tx.account.create({
    data: {
      accountNumber: makeIban(customer.branch.code, serial),
      customerId: customer.id,
      branchId: customer.branchId,
      type: input.type,
      currency: input.currency,
      status,
      nickname: input.nickname,
      interestRateBps: input.interestRateBps ?? (input.type === "SAVINGS" ? SAVINGS_RATES[input.currency] : 0),
      glAccountId: gl.id,
      openedById: input.openedById,
      openedAt: input.openedAt ?? new Date(),
      activatedAt: status === "ACTIVE" ? input.openedAt ?? new Date() : null,
      lastActivityAt: input.openedAt ?? new Date(),
    },
  });
}

const openInput = z.object({
  customerId: z.string(),
  type: z.enum(["CURRENT", "SAVINGS"]),
  currency: z.enum(["EGP", "USD", "EUR", "SAR"]),
  nickname: z.string().max(60).optional(),
});

export async function openAccount(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "account.open");
  const input = openInput.parse(raw);
  const c = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  return withTx(async (tx) => {
    const a = await createAccountRow(tx, { ...input, openedById: staff.id });
    await audit(actor, "ACCOUNT_OPENED", { type: "Account", id: a.id }, undefined, a, tx);
    await notify(tx, c.id, { titleAr: "تم فتح حساب جديد", titleEn: "New account opened", bodyAr: `رقم الحساب ${a.accountNumber}`, bodyEn: `Account ${a.accountNumber}` });
    return a;
  });
}

export async function listAccounts(staff: StaffPrincipal, f: { q?: string; status?: string; type?: string; take?: number } = {}) {
  requirePerm(staff, "account.read");
  const where: Prisma.AccountWhereInput = { ...branchWhere(staff) };
  if (f.status) where.status = f.status as AccountStatus;
  if (f.type) where.type = f.type as AccountType;
  if (f.q) where.OR = [{ accountNumber: { contains: f.q.toUpperCase().replace(/\s/g, "") } }, { customer: { nameEn: { contains: f.q, mode: "insensitive" } } }, { customer: { nameAr: { contains: f.q } } }, { customer: { cif: { contains: f.q.toUpperCase() } } }];
  return prisma.account.findMany({ where, include: { customer: true, branch: true }, orderBy: { openedAt: "desc" }, take: f.take ?? 100 });
}

export async function getAccount(staff: StaffPrincipal, id: string) {
  requirePerm(staff, "account.read");
  const a = await prisma.account.findUnique({ where: { id }, include: { customer: true, branch: true, termDeposit: true, cards: true } });
  if (!a) throw Errors.notFound("Account");
  assertBranchAccess(staff, a.branchId);
  return a;
}

/** Statement with opening balance and running balance computed from the ledger (source of truth). */
export async function accountStatement(accountId: string, from?: Date, to?: Date) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, include: { customer: true, branch: true } });
  const fromD = from ?? new Date(Date.now() - 90 * 86400_000);
  const toD = to ?? new Date();
  const opening = await prisma.journalLine.aggregate({ where: { accountId, entry: { postedAt: { lt: fromD } } }, _sum: { debit: true, credit: true } });
  let running = (opening._sum.credit ?? 0n) - (opening._sum.debit ?? 0n);
  const openingBalance = running;
  const lines = await prisma.journalLine.findMany({
    where: { accountId, entry: { postedAt: { gte: fromD, lte: toD } } },
    include: { entry: true },
    orderBy: [{ entry: { postedAt: "asc" } }, { id: "asc" }],
  });
  const rows = lines.map((l) => {
    running += l.credit - l.debit;
    return { id: l.id, date: l.entry.postedAt, valueDate: l.entry.valueDate, entryNo: l.entry.entryNo, type: l.entry.type, description: l.narrative || l.entry.description, debit: l.debit, credit: l.credit, balance: running, status: l.entry.status };
  });
  return { account, from: fromD, to: toD, openingBalance, closingBalance: running, rows };
}

const statusInput = z.object({ status: z.enum(["ACTIVE", "DORMANT", "FROZEN", "CLOSED"]), reason: z.string().min(3).max(300) });

/** Sensitive: freeze/unfreeze/close/reactivate requires maker-checker. */
export async function requestStatusChange(staff: StaffPrincipal, actor: Actor, accountId: string, raw: unknown) {
  requirePerm(staff, "account.status");
  const input = statusInput.parse(raw);
  const a = await prisma.account.findUnique({ where: { id: accountId } });
  if (!a) throw Errors.notFound("Account");
  assertBranchAccess(staff, a.branchId);
  if (a.status === input.status) throw Errors.validation("Account already in that status");
  if (a.status === "CLOSED") throw Errors.validation("Closed accounts cannot be changed");
  const pending = await prisma.approvalRequest.findFirst({ where: { type: "ACCOUNT_STATUS", entityId: accountId, status: "PENDING" } });
  if (pending) throw Errors.conflict("A status change is already pending approval");
  return createApproval(prisma, actor, {
    type: "ACCOUNT_STATUS",
    summary: `${a.accountNumber}: ${a.status} → ${input.status} (${input.reason})`,
    payload: { accountId, from: a.status, to: input.status, reason: input.reason },
    makerId: staff.id,
    entityType: "Account",
    entityId: accountId,
    branchId: a.branchId,
  });
}

export async function executeStatusChange(tx: Tx, payload: { accountId: string; to: AccountStatus; reason: string }, actor: Actor) {
  await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${payload.accountId} FOR UPDATE`;
  const a = await tx.account.findUniqueOrThrow({ where: { id: payload.accountId } });
  if (a.status === "CLOSED") throw new AppError("INVALID_STATE", 409, "Account closed");
  if (payload.to === "CLOSED") {
    if (a.balance !== 0n) throw new AppError("NONZERO_BALANCE", 422, "Account balance must be zero before closing");
    const activeCards = await tx.card.count({ where: { accountId: a.id, status: { in: ["ACTIVE", "FROZEN"] } } });
    if (activeCards) await tx.card.updateMany({ where: { accountId: a.id }, data: { status: "CANCELLED" } });
  }
  const after = await tx.account.update({
    where: { id: a.id },
    data: { status: payload.to, closedAt: payload.to === "CLOSED" ? new Date() : undefined, lastActivityAt: payload.to === "ACTIVE" ? new Date() : undefined },
  });
  await audit(actor, "ACCOUNT_STATUS_CHANGED", { type: "Account", id: a.id }, { status: a.status }, { status: after.status, reason: payload.reason }, tx);
  await notify(tx, a.customerId, {
    titleAr: "تغيير حالة الحساب", titleEn: "Account status changed",
    bodyAr: `حالة الحساب ${a.accountNumber} أصبحت ${payload.to}`, bodyEn: `Account ${a.accountNumber} is now ${payload.to}`,
  });
  return after;
}
