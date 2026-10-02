import { z } from "zod";
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma, Tx, nextSeq, withTx, isUniqueViolation } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { amortize } from "@/lib/amortization";
import { addMonths, dateOnly, daysBetween, todayStr } from "@/lib/dates";
import { toMinor, roundMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal, type LineInput } from "@/server/ledger";
import { assertBranchAccess, branchWhere, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { computeFee } from "./fees";
import { notify } from "./notify";

export const loanApplyInput = z.object({
  customerId: z.string(),
  productId: z.string(),
  amount: z.string(),
  termMonths: z.coerce.number().int().min(1).max(120),
  accountId: z.string(), // disbursement + repayment account
  purpose: z.string().max(200).optional(),
});

export async function createLoanApplication(tx: Tx, input: z.infer<typeof loanApplyInput>, meta: { staffId?: string; channel: string; createdAt?: Date }) {
  const [product, account, customer] = await Promise.all([
    tx.loanProduct.findUnique({ where: { id: input.productId } }),
    tx.account.findUnique({ where: { id: input.accountId } }),
    tx.customer.findUnique({ where: { id: input.customerId } }),
  ]);
  if (!product || !product.active) throw Errors.notFound("Loan product");
  if (!customer) throw Errors.notFound("Customer");
  if (customer.kycStatus !== "APPROVED") throw new AppError("KYC_REQUIRED", 422, "Customer KYC must be approved");
  if (!account || account.customerId !== customer.id) throw Errors.validation("Account must belong to the customer");
  if (account.currency !== product.currency || account.type === "TERM_DEPOSIT") throw Errors.validation("Account currency/type not valid for this product");
  const amount = toMinor(input.amount);
  if (amount < product.minAmount || amount > product.maxAmount) throw Errors.validation("Amount outside product limits");
  if (input.termMonths < product.minTermMonths || input.termMonths > product.maxTermMonths) throw Errors.validation("Term outside product limits");
  const n = await nextSeq(tx, "nb_loan_seq");
  return tx.loan.create({
    data: {
      loanNumber: `LN${n}`, customerId: customer.id, productId: product.id, branchId: customer.branchId, currency: product.currency,
      principal: amount, annualRateBps: product.annualRateBps, termMonths: input.termMonths, purpose: input.purpose,
      disbursementAccountId: account.id, repaymentAccountId: account.id, appliedById: meta.staffId, channel: meta.channel, createdAt: meta.createdAt,
    },
  });
}

export async function applyLoan(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "loan.apply");
  const input = loanApplyInput.parse(raw);
  const c = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  return withTx(async (tx) => {
    const loan = await createLoanApplication(tx, input, { staffId: staff.id, channel: "BRANCH" });
    await audit(actor, "LOAN_APPLIED", { type: "Loan", id: loan.id }, undefined, loan, tx);
    return loan;
  });
}

export async function listLoans(staff: StaffPrincipal, f: { status?: string } = {}) {
  requirePerm(staff, "loan.read");
  const where: Prisma.LoanWhereInput = { ...branchWhere(staff) };
  if (f.status) where.status = f.status as Prisma.EnumLoanStatusFilter["equals"];
  return prisma.loan.findMany({ where, include: { customer: true, product: true, branch: true }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function getLoan(staff: StaffPrincipal, id: string) {
  requirePerm(staff, "loan.read");
  const l = await prisma.loan.findUnique({ where: { id }, include: { customer: true, product: true, branch: true, installments: { orderBy: { seq: "asc" } } } });
  if (!l) throw Errors.notFound("Loan");
  assertBranchAccess(staff, l.branchId);
  return l;
}

/** Credit workflow: APPLIED -(officer)-> RECOMMENDED -(manager, different person)-> APPROVED -> DISBURSED */
export async function loanDecision(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  const { action, reason } = z.object({ action: z.enum(["RECOMMEND", "APPROVE", "REJECT"]), reason: z.string().max(300).optional() }).parse(raw);
  const loan = await prisma.loan.findUnique({ where: { id } });
  if (!loan) throw Errors.notFound("Loan");
  assertBranchAccess(staff, loan.branchId);
  let data: Prisma.LoanUpdateInput;
  if (action === "RECOMMEND") {
    requirePerm(staff, "loan.recommend");
    if (loan.status !== "APPLIED") throw new AppError("INVALID_STATE", 409, "Loan is not in APPLIED state");
    data = { status: "RECOMMENDED", recommendedById: staff.id, recommendedAt: new Date() };
  } else if (action === "APPROVE") {
    requirePerm(staff, "loan.approve");
    if (loan.status !== "RECOMMENDED") throw new AppError("INVALID_STATE", 409, "Loan must be recommended first");
    if (loan.recommendedById === staff.id || loan.appliedById === staff.id) throw new AppError("FOUR_EYES_VIOLATION", 403, "Approver must differ from applicant/recommender");
    data = { status: "APPROVED", approvedById: staff.id, approvedAt: new Date() };
  } else {
    if (!(staff.role === "CREDIT_MANAGER" || staff.role === "CREDIT_OFFICER" || staff.role === "SUPER_ADMIN")) throw Errors.forbidden();
    if (!["APPLIED", "RECOMMENDED"].includes(loan.status)) throw new AppError("INVALID_STATE", 409, "Loan cannot be rejected now");
    data = { status: "REJECTED", rejectedById: staff.id, rejectReason: reason ?? "Rejected" };
  }
  const after = await prisma.loan.update({ where: { id }, data });
  await audit(actor, `LOAN_${action}`, { type: "Loan", id }, { status: loan.status }, { status: after.status, reason });
  if (action !== "RECOMMEND") {
    await notify(prisma, loan.customerId, {
      titleAr: action === "APPROVE" ? "تمت الموافقة على القرض" : "تم رفض طلب القرض", titleEn: action === "APPROVE" ? "Loan approved" : "Loan rejected",
      bodyAr: `طلب القرض ${loan.loanNumber}`, bodyEn: `Loan application ${loan.loanNumber}`,
    });
  }
  return after;
}

/** Disbursement: builds schedule, Dr Loans / Cr customer account, admin fee to income. */
export async function disburseLoanTx(tx: Tx, loanId: string, meta: { staffId?: string; postedAt?: Date; valueDate?: string }) {
  await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId} FOR UPDATE`;
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId }, include: { product: true } });
  if (loan.status !== "APPROVED") throw new AppError("INVALID_STATE", 409, "Loan must be approved before disbursement");
  const start = dateOnly(meta.valueDate ?? todayStr(meta.postedAt));
  const firstDue = addMonths(start, 1);
  const schedule = amortize(loan.principal, loan.annualRateBps, loan.termMonths, firstDue);
  await tx.loanInstallment.createMany({
    data: schedule.map((s) => ({ loanId, seq: s.seq, dueDate: s.dueDate, principalDue: s.principal, interestDue: s.interest })),
  });
  const { fee } = await computeFee(tx, "LOAN_DISBURSEMENT", loan.principal, loan.currency);
  const lines: LineInput[] = [
    { loanId: loan.id, debit: loan.principal, narrative: `Disbursement ${loan.loanNumber}` },
    { accountId: loan.disbursementAccountId, credit: loan.principal, narrative: `Loan ${loan.loanNumber} disbursement` },
  ];
  if (fee > 0n) lines.push({ accountId: loan.disbursementAccountId, debit: fee, narrative: `Loan ${loan.loanNumber} admin fee` }, { glCode: GL.FEE_INCOME, credit: fee });
  const { entry } = await postJournal(tx, {
    idempotencyKey: `loan-disburse:${loan.id}`, type: "LOAN_DISBURSEMENT", currency: loan.currency, channel: "BRANCH", branchId: loan.branchId,
    staffId: meta.staffId, description: `Loan ${loan.loanNumber} disbursement`, reference: loan.loanNumber, lines, postedAt: meta.postedAt, valueDate: meta.valueDate,
  });
  const after = await tx.loan.update({ where: { id: loan.id }, data: { status: "DISBURSED", disbursedById: meta.staffId, disbursedAt: meta.postedAt ?? new Date(), firstDueDate: firstDue } });
  await notify(tx, loan.customerId, { titleAr: "تم صرف القرض", titleEn: "Loan disbursed", bodyAr: `تم صرف القرض ${loan.loanNumber}`, bodyEn: `Loan ${loan.loanNumber} was credited to your account`, createdAt: meta.postedAt });
  return { loan: after, entry };
}

export async function disburseLoan(staff: StaffPrincipal, actor: Actor, id: string) {
  requirePerm(staff, "loan.disburse");
  const loan = await prisma.loan.findUnique({ where: { id } });
  if (!loan) throw Errors.notFound("Loan");
  assertBranchAccess(staff, loan.branchId);
  if (loan.approvedById === staff.id && staff.role !== "SUPER_ADMIN") {
    // allowed: credit manager approves & disburses; maker-checker satisfied by officer/manager split
  }
  return withTx(async (tx) => {
    const r = await disburseLoanTx(tx, id, { staffId: staff.id });
    await audit(actor, "LOAN_DISBURSED", { type: "Loan", id }, { status: "APPROVED" }, { status: "DISBURSED", entry: r.entry.entryNo }, tx);
    return r.loan;
  });
}

/**
 * Repayment allocation: oldest installment first; within an installment penalty → interest → principal.
 * Interest and penalties are recognised as income when collected (cash basis).
 */
export async function repayLoanTx(tx: Tx, loanId: string, amount: bigint, opts: { fromAccountId?: string; idempotencyKey: string; staffId?: string; customerId?: string; channel?: "BRANCH" | "PORTAL" | "SYSTEM"; postedAt?: Date; valueDate?: string }) {
  await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId} FOR UPDATE`;
  const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
  if (existing) return { entry: existing, replayed: true, allocated: 0n };
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId }, include: { installments: { orderBy: { seq: "asc" } } } });
  if (loan.status !== "DISBURSED") throw new AppError("INVALID_STATE", 409, "Loan is not active");
  if (amount <= 0n) throw Errors.validation("Amount must be positive");
  const fromAccountId = opts.fromAccountId ?? loan.repaymentAccountId;
  let remaining = amount;
  let pPrin = 0n, pInt = 0n, pPen = 0n;
  const updates: { id: string; principalPaid: bigint; interestPaid: bigint; penaltyPaid: bigint; status: string; paidAt?: Date }[] = [];
  for (const ins of loan.installments) {
    if (remaining <= 0n) break;
    if (ins.status === "PAID") continue;
    const pen = ins.penaltyDue - ins.penaltyPaid;
    const int = ins.interestDue - ins.interestPaid;
    const pr = ins.principalDue - ins.principalPaid;
    const aPen = remaining < pen ? remaining : pen; remaining -= aPen;
    const aInt = remaining < int ? remaining : int; remaining -= aInt;
    const aPr = remaining < pr ? remaining : pr; remaining -= aPr;
    if (aPen + aInt + aPr === 0n) continue;
    pPen += aPen; pInt += aInt; pPrin += aPr;
    const fully = aPen === pen && aInt === int && aPr === pr;
    updates.push({ id: ins.id, principalPaid: ins.principalPaid + aPr, interestPaid: ins.interestPaid + aInt, penaltyPaid: ins.penaltyPaid + aPen, status: fully ? "PAID" : "PARTIAL", paidAt: fully ? opts.postedAt ?? new Date() : undefined });
  }
  const allocated = pPrin + pInt + pPen;
  if (allocated === 0n) throw Errors.validation("Nothing due on this loan");
  const lines: LineInput[] = [{ accountId: fromAccountId, debit: allocated, narrative: `Loan ${loan.loanNumber} repayment` }];
  if (pPrin > 0n) lines.push({ loanId: loan.id, credit: pPrin, narrative: "Principal" });
  if (pInt > 0n) lines.push({ glCode: GL.LOAN_INTEREST_INCOME, credit: pInt, narrative: `Interest ${loan.loanNumber}` });
  if (pPen > 0n) lines.push({ glCode: GL.PENALTY_INCOME, credit: pPen, narrative: `Penalty ${loan.loanNumber}` });
  const res = await postJournal(tx, {
    idempotencyKey: opts.idempotencyKey, type: "LOAN_REPAYMENT", currency: loan.currency, channel: opts.channel ?? "BRANCH", branchId: loan.branchId,
    staffId: opts.staffId, customerId: opts.customerId, description: `Loan ${loan.loanNumber} repayment`, reference: loan.loanNumber, lines,
    postedAt: opts.postedAt, valueDate: opts.valueDate,
  });
  for (const u of updates) {
    await tx.loanInstallment.update({ where: { id: u.id }, data: { principalPaid: u.principalPaid, interestPaid: u.interestPaid, penaltyPaid: u.penaltyPaid, status: u.status, paidAt: u.paidAt } });
  }
  const openCount = await tx.loanInstallment.count({ where: { loanId, status: { not: "PAID" } } });
  if (openCount === 0) await tx.loan.update({ where: { id: loanId }, data: { status: "CLOSED", closedAt: opts.postedAt ?? new Date(), daysPastDue: 0, classification: "CURRENT" } });
  return { ...res, allocated };
}

export async function repayLoan(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "loan.repay");
  const input = z.object({ amount: z.string(), idempotencyKey: z.string().min(8) }).parse(raw);
  const loan = await prisma.loan.findUnique({ where: { id } });
  if (!loan) throw Errors.notFound("Loan");
  assertBranchAccess(staff, loan.branchId);
  try {
    return await withTx(async (tx) => {
      const r = await repayLoanTx(tx, id, toMinor(input.amount), { idempotencyKey: `loan-repay:${staff.id}:${input.idempotencyKey}`, staffId: staff.id });
      if (!r.replayed) await audit(actor, "LOAN_REPAYMENT", { type: "Loan", id }, undefined, { amount: r.allocated, entry: r.entry.entryNo }, tx);
      return r;
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotencyKey")) return { entry: await prisma.journalEntry.findUnique({ where: { idempotencyKey: `loan-repay:${staff.id}:${input.idempotencyKey}` } }), replayed: true };
    throw e;
  }
}

export function classify(dpd: number): string {
  if (dpd <= 0) return "CURRENT";
  if (dpd <= 30) return "DPD_1_30";
  if (dpd <= 60) return "DPD_31_60";
  if (dpd <= 90) return "DPD_61_90";
  return "NPL_90_PLUS";
}

/**
 * EOD loan processing for a business date:
 *  1) auto-collect due amounts from the repayment account (as much as available)
 *  2) daily penalty interest on overdue amounts (penaltyRate/365, rounded)
 *  3) days-past-due & NPL classification
 */
export async function processLoansEod(date: Date, postedAt?: Date) {
  const loans = await prisma.loan.findMany({ where: { status: "DISBURSED" }, include: { product: true } });
  const dateS = date.toISOString().slice(0, 10);
  let collected = 0n, penalties = 0n;
  for (const loan of loans) {
    await withTx(async (tx) => {
      const due = await tx.loanInstallment.findMany({ where: { loanId: loan.id, status: { not: "PAID" }, dueDate: { lte: date } }, orderBy: { seq: "asc" } });
      if (due.length) {
        const owed = due.reduce((s, i) => s + (i.principalDue - i.principalPaid) + (i.interestDue - i.interestPaid) + (i.penaltyDue - i.penaltyPaid), 0n);
        const acc = await tx.account.findUnique({ where: { id: loan.repaymentAccountId } });
        if (acc && acc.status === "ACTIVE" && acc.balance > 0n && owed > 0n) {
          const amt = acc.balance < owed ? acc.balance : owed;
          const r = await repayLoanTx(tx, loan.id, amt, { idempotencyKey: `loan-autocollect:${loan.id}:${dateS}`, channel: "SYSTEM", postedAt, valueDate: dateS });
          collected += r.allocated;
        }
      }
      const overdue = await tx.loanInstallment.findMany({ where: { loanId: loan.id, status: { not: "PAID" }, dueDate: { lt: date } }, orderBy: { seq: "asc" } });
      for (const ins of overdue) {
        const overdueAmt = (ins.principalDue - ins.principalPaid) + (ins.interestDue - ins.interestPaid);
        const pen = roundMinor(new Decimal(overdueAmt.toString()).mul(loan.product.penaltyRateBps).div(10000).div(365));
        penalties += pen;
        await tx.loanInstallment.update({ where: { id: ins.id }, data: { penaltyDue: { increment: pen }, status: "OVERDUE" } });
      }
      const dpd = overdue.length ? daysBetween(overdue[0].dueDate, date) : 0;
      const stillOpen = await tx.loan.findUnique({ where: { id: loan.id } });
      if (stillOpen?.status === "DISBURSED") await tx.loan.update({ where: { id: loan.id }, data: { daysPastDue: dpd, classification: classify(dpd) } });
    });
  }
  return { loans: loans.length, collected, penalties };
}
