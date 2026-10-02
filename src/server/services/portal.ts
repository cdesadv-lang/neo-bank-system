import { z } from "zod";
import { prisma, nextSeq, withTx, isUniqueViolation } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { isValidIban, bankCodeOf, BANK_CODE } from "@/lib/iban";
import { toEgpEquivalent } from "@/lib/fx";
import { dateOnly, todayStr } from "@/lib/dates";
import { toMinor, minorToString } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { GL } from "@/server/gl";
import { postJournal } from "@/server/ledger";
import { issueOtp, verifyOtp } from "@/server/auth/otp";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "@/server/auth/password";
import { enforceRateLimit } from "@/server/auth/ratelimit";
import type { CustomerPrincipal } from "@/server/auth/session";
import { accountStatement, createAccountRow } from "./accounts";
import { newCif } from "./customers";
import { createApproval } from "./approval-request";
import { executeTransfer, transferInput, BANKS } from "./transfers";
import { MockBillerAdapter } from "./billers";
import { createLoanApplication } from "./loans";
import { openTermDepositTx, tdInput } from "./deposits";
import { notify } from "./notify";

/** Portal daily transfer limit (EGP equivalent) across all portal transfers + bills. */
export const PORTAL_DAILY_LIMIT = 50_000_000n; // EGP 500,000.00

export async function myAccounts(customerId: string) {
  return prisma.account.findMany({ where: { customerId, status: { not: "CLOSED" } }, orderBy: [{ type: "asc" }, { openedAt: "asc" }], include: { termDeposit: true } });
}

/** Ownership check — the only way the portal ever reaches an account. */
export async function myAccount(customerId: string, accountId: string) {
  const a = await prisma.account.findUnique({ where: { id: accountId }, include: { termDeposit: true } });
  if (!a || a.customerId !== customerId) throw Errors.notFound("Account");
  return a;
}

export async function myStatement(customerId: string, accountId: string, from?: Date, to?: Date) {
  await myAccount(customerId, accountId);
  return accountStatement(accountId, from, to);
}

async function checkDailyLimit(customerId: string, add: bigint, currency: string) {
  const since = dateOnly(todayStr());
  const rows = await prisma.transfer.findMany({ where: { initiatedByCustomerId: customerId, createdAt: { gte: since }, status: { notIn: ["FAILED", "REJECTED"] } }, select: { amount: true, currency: true } });
  const bills = await prisma.billPayment.findMany({ where: { customerId, createdAt: { gte: since } }, select: { amount: true, currency: true } });
  const used = [...rows, ...bills].reduce((s, r) => s + toEgpEquivalent(r.amount, r.currency), 0n);
  if (used + toEgpEquivalent(add, currency) > PORTAL_DAILY_LIMIT) throw new AppError("DAILY_LIMIT_EXCEEDED", 422, `Daily online limit of EGP ${minorToString(PORTAL_DAILY_LIMIT)} exceeded`);
}

/** Step 1 of a portal transfer: validate and send an OTP. Nothing moves yet. */
export async function startTransfer(c: CustomerPrincipal, raw: unknown) {
  const input = transferInput.parse(raw);
  if (c.kycStatus !== "APPROVED") throw new AppError("KYC_REQUIRED", 422, "Your profile is pending approval");
  const from = await myAccount(c.customerId, input.fromAccountId);
  if (from.status !== "ACTIVE") throw new AppError("ACCOUNT_NOT_ACTIVE", 422, `Account is ${from.status}`);
  if (!isValidIban(input.toAccountNumber)) throw new AppError("INVALID_IBAN", 422, "Invalid destination account number");
  const amount = toMinor(input.amount);
  if (amount <= 0n) throw Errors.validation("Amount must be positive");
  if (amount > from.balance) throw Errors.insufficientFunds();
  await checkDailyLimit(c.customerId, amount, from.currency);
  let toName = input.toName;
  if (bankCodeOf(input.toAccountNumber) === BANK_CODE) {
    const to = await prisma.account.findUnique({ where: { accountNumber: input.toAccountNumber }, include: { customer: true } });
    if (!to) throw new AppError("BENEFICIARY_NOT_FOUND", 422, "Destination account not found");
    toName = to.customer.nameEn.replace(/(\w)\w+/g, "$1***");
  } else if (!BANKS[bankCodeOf(input.toAccountNumber)]) throw new AppError("UNKNOWN_BANK", 422, "Unknown destination bank");
  const otp = await issueOtp({ subject: c.userId, phone: c.phone, purpose: "TRANSFER", payload: input });
  return { challengeId: otp.challengeId, expiresAt: otp.expiresAt, preview: { from: from.accountNumber, to: input.toAccountNumber, toName, amount: input.amount, currency: from.currency } };
}

/** Step 2: OTP confirmation executes the transfer exactly once. */
export async function confirmTransfer(c: CustomerPrincipal, actor: Actor, raw: unknown) {
  const { challengeId, code } = z.object({ challengeId: z.string(), code: z.string() }).parse(raw);
  await enforceRateLimit(`otp-confirm:${c.userId}`, 20, 900);
  const payload = await verifyOtp(challengeId, c.userId, "TRANSFER", code);
  const input = transferInput.parse(payload);
  const from = await myAccount(c.customerId, input.fromAccountId);
  await checkDailyLimit(c.customerId, toMinor(input.amount), from.currency);
  return executeTransfer({ kind: "CUSTOMER", customerId: c.customerId, actor }, input);
}

export const beneficiaryInput = z.object({ name: z.string().min(2).max(140), accountNumber: z.string().transform((s) => s.replace(/\s+/g, "").toUpperCase()) });

export async function addBeneficiary(c: CustomerPrincipal, actor: Actor, raw: unknown) {
  const input = beneficiaryInput.parse(raw);
  if (!isValidIban(input.accountNumber)) throw new AppError("INVALID_IBAN", 422, "Invalid account number (check digits)");
  const bankCode = bankCodeOf(input.accountNumber);
  if (!BANKS[bankCode]) throw new AppError("UNKNOWN_BANK", 422, "Unknown bank");
  const b = await prisma.beneficiary.create({ data: { customerId: c.customerId, name: input.name, accountNumber: input.accountNumber, bankCode, bankName: BANKS[bankCode], isInternal: bankCode === BANK_CODE } }).catch((e) => {
    if (isUniqueViolation(e)) throw Errors.conflict("Beneficiary already saved");
    throw e;
  });
  await audit(actor, "BENEFICIARY_ADDED", { type: "Beneficiary", id: b.id }, undefined, b);
  return b;
}

export async function removeBeneficiary(c: CustomerPrincipal, actor: Actor, id: string) {
  const b = await prisma.beneficiary.findUnique({ where: { id } });
  if (!b || b.customerId !== c.customerId) throw Errors.notFound("Beneficiary");
  await prisma.beneficiary.delete({ where: { id } });
  await audit(actor, "BENEFICIARY_REMOVED", { type: "Beneficiary", id }, b, undefined);
  return { ok: true };
}

const billInput = z.object({ accountId: z.string(), billerCode: z.string(), billReference: z.string(), amount: z.string().optional(), idempotencyKey: z.string().min(8) });

export async function billInquiry(code: string, ref: string) {
  const r = MockBillerAdapter.inquire(code, ref);
  if (!r) throw Errors.validation("Unknown biller or invalid reference");
  return { amountDue: minorToString(r.amountDue), billerCode: code, reference: ref, mock: true };
}

export async function startBillPayment(c: CustomerPrincipal, raw: unknown) {
  const input = billInput.parse(raw);
  if (c.kycStatus !== "APPROVED") throw new AppError("KYC_REQUIRED", 422, "Your profile is pending approval");
  const acc = await myAccount(c.customerId, input.accountId);
  if (acc.currency !== "EGP") throw Errors.validation("Bills are payable from EGP accounts only");
  const inq = MockBillerAdapter.inquire(input.billerCode, input.billReference);
  if (!inq) throw Errors.validation("Unknown biller or invalid reference");
  const amount = input.amount ? toMinor(input.amount) : inq.amountDue;
  if (amount > acc.balance) throw Errors.insufficientFunds();
  await checkDailyLimit(c.customerId, amount, "EGP");
  const otp = await issueOtp({ subject: c.userId, phone: c.phone, purpose: "BILL_PAYMENT", payload: { ...input, amount: minorToString(amount) } });
  return { challengeId: otp.challengeId, amount: minorToString(amount) };
}

export async function confirmBillPayment(c: CustomerPrincipal, actor: Actor, raw: unknown, postedAt?: Date) {
  const { challengeId, code } = z.object({ challengeId: z.string(), code: z.string() }).parse(raw);
  const payload = billInput.extend({ amount: z.string() }).parse(await verifyOtp(challengeId, c.userId, "BILL_PAYMENT", code));
  return payBillTx(c.customerId, actor, payload, postedAt);
}

export async function payBillTx(customerId: string, actor: Actor, p: z.infer<typeof billInput> & { amount: string }, postedAt?: Date) {
  const biller = MockBillerAdapter.list().find((b) => b.code === p.billerCode);
  if (!biller) throw Errors.validation("Unknown biller");
  const amount = toMinor(p.amount);
  return withTx(async (tx) => {
    const acc = await tx.account.findUnique({ where: { id: p.accountId } });
    if (!acc || acc.customerId !== customerId) throw Errors.notFound("Account");
    const n = await nextSeq(tx, "nb_bill_seq");
    const ref = `BILL${String(n).padStart(8, "0")}`;
    const { entry, replayed } = await postJournal(tx, {
      idempotencyKey: `bill:${customerId}:${p.idempotencyKey}`, type: "BILL_PAYMENT", currency: "EGP", channel: "PORTAL", customerId, branchId: acc.branchId,
      description: `${biller.nameEn} — ${p.billReference}`, reference: ref, postedAt,
      lines: [{ accountId: acc.id, debit: amount, narrative: `${biller.nameEn} ${p.billReference}` }, { glCode: GL.BILLS_PAYABLE, credit: amount, narrative: `${biller.code} ${p.billReference}` }],
    });
    if (replayed) return tx.billPayment.findFirstOrThrow({ where: { journalEntryId: entry.id } });
    const receipt = await MockBillerAdapter.pay(p.billerCode, p.billReference, amount);
    const bp = await tx.billPayment.create({
      data: { reference: ref, customerId, accountId: acc.id, billerCode: biller.code, billerName: biller.nameEn, billReference: p.billReference, amount, currency: "EGP", journalEntryId: entry.id, createdAt: postedAt },
    });
    await audit(actor, "BILL_PAID", { type: "BillPayment", id: bp.id }, undefined, { ...bp, receipt: receipt.receipt }, tx);
    return bp;
  });
}

export async function portalApplyLoan(c: CustomerPrincipal, actor: Actor, raw: unknown) {
  const input = z.object({ productId: z.string(), amount: z.string(), termMonths: z.coerce.number().int(), accountId: z.string(), purpose: z.string().max(200).optional() }).parse(raw);
  await myAccount(c.customerId, input.accountId);
  return withTx(async (tx) => {
    const loan = await createLoanApplication(tx, { ...input, customerId: c.customerId }, { channel: "PORTAL" });
    await audit(actor, "LOAN_APPLIED", { type: "Loan", id: loan.id }, undefined, loan, tx);
    return loan;
  });
}

export async function portalOpenTd(c: CustomerPrincipal, actor: Actor, raw: unknown) {
  if (c.kycStatus !== "APPROVED") throw new AppError("KYC_REQUIRED", 422, "Your profile is pending approval");
  const input = tdInput.parse(raw);
  await myAccount(c.customerId, input.sourceAccountId);
  return withTx(async (tx) => {
    const r = await openTermDepositTx(tx, input, { customerId: c.customerId, channel: "PORTAL" });
    if (!r.replayed) await audit(actor, "TD_OPENED", { type: "TermDeposit", id: r.td?.id }, undefined, r.td, tx);
    return r;
  });
}

export async function changeCustomerPassword(c: CustomerPrincipal, actor: Actor, raw: unknown) {
  const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(raw);
  const u = await prisma.customerUser.findUniqueOrThrow({ where: { id: c.userId } });
  if (!(await verifyPassword(current, u.passwordHash))) throw new AppError("INVALID_CREDENTIALS", 401, "Current password is wrong");
  const err = checkPasswordPolicy(next);
  if (err) throw Errors.validation(err);
  await prisma.customerUser.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(next) } });
  await prisma.customerSession.deleteMany({ where: { userId: u.id } });
  await audit(actor, "CUSTOMER_PASSWORD_CHANGED", { type: "Customer", id: c.customerId });
  return { ok: true, reLogin: true };
}

// ---------------- Onboarding ----------------
export const onboardingInput = z.object({
  nameAr: z.string().min(5).max(200),
  nameEn: z.string().min(5).max(200),
  nationalId: z.string().regex(/^\d{14}$/, "National ID must be 14 digits"),
  phone: z.string().regex(/^\+20(10|11|12|15)\d{8}$/, "Egyptian mobile in +201XXXXXXXXX format"),
  email: z.string().email().optional().or(z.literal("")),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.string().min(5).max(300),
  branchCode: z.string().regex(/^\d{4}$/),
  username: z.string().regex(/^[a-z0-9._-]{4,32}$/, "4–32 lowercase letters, digits, . _ -"),
  password: z.string(),
  currency: z.enum(["EGP", "USD", "EUR", "SAR"]).default("EGP"),
});

export async function startOnboarding(raw: unknown, ip: string) {
  await enforceRateLimit(`onboard:ip:${ip}`, 10, 3600);
  const input = onboardingInput.parse(raw);
  const err = checkPasswordPolicy(input.password);
  if (err) throw Errors.validation(err);
  const branch = await prisma.branch.findUnique({ where: { code: input.branchCode } });
  if (!branch) throw Errors.validation("Unknown branch");
  const [dupC, dupU] = await Promise.all([
    prisma.customer.findFirst({ where: { OR: [{ nationalId: input.nationalId }, { phone: input.phone }] } }),
    prisma.customerUser.findUnique({ where: { username: input.username } }),
  ]);
  if (dupC) throw Errors.conflict("A customer with this national ID or phone already exists — please visit a branch");
  if (dupU) throw Errors.conflict("Username already taken");
  const { password, ...rest } = input;
  const passwordHash = await hashPassword(password);
  const otp = await issueOtp({ subject: input.phone, phone: input.phone, purpose: "ONBOARDING", payload: { ...rest, passwordHash } });
  return { challengeId: otp.challengeId, expiresAt: otp.expiresAt };
}

/** Verifies the mobile number, then creates a PENDING CIF + pending account + KYC approval request for staff. */
export async function completeOnboarding(raw: unknown, ip: string, ua: string) {
  const { challengeId, phone, code } = z.object({ challengeId: z.string(), phone: z.string(), code: z.string() }).parse(raw);
  await enforceRateLimit(`onboard-verify:ip:${ip}`, 20, 3600);
  const payload = (await verifyOtp(challengeId, phone, "ONBOARDING", code)) as z.infer<typeof onboardingInput> & { passwordHash: string };
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: payload.branchCode } });
  return withTx(async (tx) => {
    const cif = await newCif(tx);
    const c = await tx.customer.create({
      data: {
        cif, type: "INDIVIDUAL", nameAr: payload.nameAr, nameEn: payload.nameEn, nationalId: payload.nationalId, phone: payload.phone, email: payload.email || null,
        dateOfBirth: new Date(payload.dateOfBirth), address: payload.address, branchId: branch.id, kycStatus: "PENDING", riskRating: "MEDIUM", source: "PORTAL",
      },
    }).catch((e) => {
      if (isUniqueViolation(e)) throw Errors.conflict("Customer already exists");
      throw e;
    });
    await tx.customerUser.create({ data: { customerId: c.id, username: payload.username, passwordHash: payload.passwordHash } });
    const acc = await createAccountRow(tx, { customerId: c.id, type: "CURRENT", currency: payload.currency ?? "EGP" });
    await tx.kycDocument.create({ data: { customerId: c.id, docType: "NATIONAL_ID", docNumber: payload.nationalId, verified: false } });
    await createApproval(tx, { type: "CUSTOMER", id: c.id, name: payload.username, ip, userAgent: ua }, {
      type: "KYC_APPROVAL", summary: `Digital onboarding KYC for ${cif} ${payload.nameEn}`, payload: { customerId: c.id }, makerId: `PORTAL:${c.id}`, entityType: "Customer", entityId: c.id, branchId: branch.id,
    });
    await notify(tx, c.id, { titleAr: "مرحباً بك في نيو بنك", titleEn: "Welcome to Neo Bank", bodyAr: "طلبك قيد المراجعة من فريق اعرف عميلك.", bodyEn: "Your application is being reviewed by our KYC team." });
    await audit({ type: "CUSTOMER", id: c.id, name: payload.username, ip, userAgent: ua }, "CUSTOMER_ONBOARDED", { type: "Customer", id: c.id }, undefined, { cif, account: acc.accountNumber }, tx);
    return { cif, accountNumber: acc.accountNumber, status: "PENDING_KYC" };
  });
}
