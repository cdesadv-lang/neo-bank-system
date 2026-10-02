import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, Tx, nextSeq, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { toMinor } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { assertBranchAccess, branchWhere, isBranchScoped, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { checkPasswordPolicy, hashPassword } from "@/server/auth/password";
import { createApproval } from "./approval-request";
import { notify } from "./notify";

export const customerInput = z.object({
  type: z.enum(["INDIVIDUAL", "CORPORATE"]),
  nameAr: z.string().min(2).max(200),
  nameEn: z.string().min(2).max(200),
  nationalId: z.string().regex(/^\d{14}$/, "National ID must be 14 digits").optional().or(z.literal("").transform(() => undefined)),
  commercialRegNo: z.string().min(3).max(30).optional().or(z.literal("").transform(() => undefined)),
  taxId: z.string().max(30).optional(),
  phone: z.string().regex(/^\+20(10|11|12|15)\d{8}$/, "Egyptian mobile in +201XXXXXXXXX format"),
  email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  dateOfBirth: z.string().optional(),
  address: z.string().max(300).optional(),
  occupation: z.string().max(100).optional(),
  monthlyIncome: z.string().optional(),
  branchId: z.string().optional(),
  riskRating: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
}).refine((v) => (v.type === "INDIVIDUAL" ? !!v.nationalId : !!v.commercialRegNo), { message: "Individuals need a national ID; corporates need a commercial register number" });

export async function newCif(tx: Tx | typeof prisma) {
  return `CIF${await nextSeq(tx, "nb_cif_seq")}`;
}

export async function listCustomers(staff: StaffPrincipal, f: { q?: string; kycStatus?: string; take?: number; skip?: number } = {}) {
  requirePerm(staff, "customer.read");
  const where: Prisma.CustomerWhereInput = { ...branchWhere(staff) };
  if (f.kycStatus) where.kycStatus = f.kycStatus as Prisma.EnumKycStatusFilter["equals"];
  if (f.q) {
    where.OR = [
      { nameAr: { contains: f.q } }, { nameEn: { contains: f.q, mode: "insensitive" } }, { cif: { contains: f.q.toUpperCase() } },
      { nationalId: { contains: f.q } }, { phone: { contains: f.q } }, { commercialRegNo: { contains: f.q } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, take: f.take ?? 50, skip: f.skip ?? 0, include: { branch: true } }),
    prisma.customer.count({ where }),
  ]);
  return { rows, total };
}

export async function getCustomer(staff: StaffPrincipal, id: string) {
  requirePerm(staff, "customer.read");
  const c = await prisma.customer.findUnique({
    where: { id },
    include: { branch: true, documents: true, accounts: { orderBy: { openedAt: "asc" } }, loans: true, cards: true, user: { select: { username: true, lastLoginAt: true, active: true } }, amlAlerts: { take: 20, orderBy: { createdAt: "desc" } } },
  });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  return c;
}

export async function createCustomer(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "customer.create");
  const input = customerInput.parse(raw);
  const branchId = isBranchScoped(staff) ? staff.branchId : input.branchId || staff.branchId;
  if (!branchId) throw Errors.validation("branchId required");
  assertBranchAccess(staff, branchId);
  return withTx(async (tx) => {
    const cif = await newCif(tx);
    const c = await tx.customer.create({
      data: {
        cif,
        type: input.type,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        nationalId: input.nationalId,
        commercialRegNo: input.commercialRegNo,
        taxId: input.taxId,
        phone: input.phone,
        email: input.email,
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : undefined,
        address: input.address,
        occupation: input.occupation,
        monthlyIncome: input.monthlyIncome ? toMinor(input.monthlyIncome) : undefined,
        branchId,
        riskRating: input.riskRating ?? "MEDIUM",
        createdById: staff.id,
        source: "BRANCH",
      },
    }).catch((e) => {
      if ((e as { code?: string }).code === "P2002") throw Errors.conflict("A customer with the same national ID / CR number / phone already exists");
      throw e;
    });
    await createApproval(tx, actor, { type: "KYC_APPROVAL", summary: `KYC approval for ${c.cif} ${c.nameEn}`, payload: { customerId: c.id }, makerId: staff.id, entityType: "Customer", entityId: c.id, branchId });
    await audit(actor, "CUSTOMER_CREATED", { type: "Customer", id: c.id }, undefined, c, tx);
    return c;
  });
}

const updateInput = z.object({
  nameAr: z.string().min(2).optional(),
  nameEn: z.string().min(2).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
  occupation: z.string().max(100).optional(),
  phone: z.string().regex(/^\+20(10|11|12|15)\d{8}$/).optional(),
  riskRating: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

export async function updateCustomer(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "customer.update");
  const patch = updateInput.parse(raw);
  if (patch.riskRating && !["SUPER_ADMIN", "COMPLIANCE_OFFICER", "BRANCH_MANAGER"].includes(staff.role)) throw Errors.forbidden("Only compliance or branch managers can change risk rating");
  const before = await prisma.customer.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Customer");
  assertBranchAccess(staff, before.branchId);
  const after = await prisma.customer.update({ where: { id }, data: patch });
  await audit(actor, "CUSTOMER_UPDATED", { type: "Customer", id }, before, after);
  return after;
}

export async function setRiskRating(staff: StaffPrincipal, actor: Actor, id: string, rating: "LOW" | "MEDIUM" | "HIGH") {
  if (!["SUPER_ADMIN", "COMPLIANCE_OFFICER", "BRANCH_MANAGER"].includes(staff.role)) throw Errors.forbidden();
  const before = await prisma.customer.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Customer");
  assertBranchAccess(staff, before.branchId);
  const after = await prisma.customer.update({ where: { id }, data: { riskRating: rating } });
  await audit(actor, "CUSTOMER_RISK_RATING", { type: "Customer", id }, { riskRating: before.riskRating }, { riskRating: rating });
  return after;
}

const docInput = z.object({
  docType: z.enum(["NATIONAL_ID", "PASSPORT", "COMMERCIAL_REGISTER", "TAX_CARD", "UTILITY_BILL", "BOARD_RESOLUTION", "OTHER"]),
  docNumber: z.string().max(50).optional(),
  fileName: z.string().max(200).optional(),
  expiryDate: z.string().optional(),
});

export async function addKycDocument(staff: StaffPrincipal, actor: Actor, customerId: string, raw: unknown) {
  requirePerm(staff, "customer.update");
  const input = docInput.parse(raw);
  const c = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  const d = await prisma.kycDocument.create({
    data: { customerId, docType: input.docType, docNumber: input.docNumber, fileName: input.fileName, expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined, verified: true, verifiedById: staff.id },
  });
  await audit(actor, "KYC_DOCUMENT_ADDED", { type: "Customer", id: customerId }, undefined, d);
  return d;
}

/** Executed by the maker-checker engine once a checker approves. */
export async function executeKycApproval(tx: Tx, payload: { customerId: string }, checker: StaffPrincipal, actor: Actor, approve = true, reason?: string) {
  const before = await tx.customer.findUnique({ where: { id: payload.customerId } });
  if (!before) throw Errors.notFound("Customer");
  if (before.kycStatus !== "PENDING") throw new AppError("INVALID_STATE", 409, "KYC already decided");
  const after = await tx.customer.update({
    where: { id: before.id },
    data: approve
      ? { kycStatus: "APPROVED", kycApprovedById: checker.id, kycApprovedAt: new Date() }
      : { kycStatus: "REJECTED", kycRejectReason: reason ?? "Rejected" },
  });
  if (approve) {
    await tx.account.updateMany({ where: { customerId: before.id, status: "PENDING" }, data: { status: "ACTIVE", activatedAt: new Date() } });
    await notify(tx, before.id, { titleAr: "تم تفعيل حسابك", titleEn: "Your profile is approved", bodyAr: "تمت الموافقة على بيانات اعرف عميلك وتفعيل حساباتك.", bodyEn: "Your KYC was approved and your accounts are now active." });
  } else {
    await notify(tx, before.id, { titleAr: "تعذر قبول طلبك", titleEn: "Onboarding rejected", bodyAr: "يرجى زيارة أقرب فرع لاستكمال البيانات.", bodyEn: "Please visit a branch to complete your KYC." });
  }
  await audit(actor, approve ? "KYC_APPROVED" : "KYC_REJECTED", { type: "Customer", id: before.id }, { kycStatus: before.kycStatus }, { kycStatus: after.kycStatus }, tx);
  return after;
}

const credInput = z.object({ username: z.string().regex(/^[a-z0-9._-]{4,32}$/), password: z.string() });

/** Branch staff enable digital banking for an existing customer. */
export async function enableDigitalBanking(staff: StaffPrincipal, actor: Actor, customerId: string, raw: unknown) {
  requirePerm(staff, "customer.update");
  const input = credInput.parse(raw);
  const pwErr = checkPasswordPolicy(input.password);
  if (pwErr) throw Errors.validation(pwErr);
  const c = await prisma.customer.findUnique({ where: { id: customerId }, include: { user: true } });
  if (!c) throw Errors.notFound("Customer");
  assertBranchAccess(staff, c.branchId);
  if (c.user) throw Errors.conflict("Digital banking already enabled");
  const u = await prisma.customerUser.create({ data: { customerId, username: input.username, passwordHash: await hashPassword(input.password) } }).catch((e) => {
    if ((e as { code?: string }).code === "P2002") throw Errors.conflict("Username taken");
    throw e;
  });
  await audit(actor, "DIGITAL_BANKING_ENABLED", { type: "Customer", id: customerId }, undefined, { username: u.username });
  return { username: u.username };
}
