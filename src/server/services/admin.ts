import { z } from "zod";
import { prisma, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { audit, type Actor } from "@/server/audit";
import { checkPasswordPolicy, hashPassword } from "@/server/auth/password";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/server/auth/totp";
import { branchWhere, isBranchScoped, BRANCH_SCOPED_ROLES, requirePerm, type StaffPrincipal } from "@/server/rbac";

const ROLES = ["SUPER_ADMIN", "BRANCH_MANAGER", "TELLER", "CUSTOMER_SERVICE", "CREDIT_OFFICER", "CREDIT_MANAGER", "COMPLIANCE_OFFICER", "OPERATIONS", "FINANCE", "AUDITOR"] as const;

export async function listStaff(staff: StaffPrincipal) {
  requirePerm(staff, "staff.read");
  return prisma.staff.findMany({ where: { ...branchWhere(staff) }, include: { branch: true }, orderBy: [{ role: "asc" }, { username: "asc" }], omit: { passwordHash: true, totpSecret: true } });
}

const staffInput = z.object({
  username: z.string().regex(/^[a-z0-9._-]{3,32}$/),
  email: z.string().email(),
  fullNameAr: z.string().min(2),
  fullNameEn: z.string().min(2),
  role: z.enum(ROLES),
  branchId: z.string().optional().nullable(),
  password: z.string(),
});

export async function createStaff(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "staff.manage");
  const input = staffInput.parse(raw);
  const err = checkPasswordPolicy(input.password);
  if (err) throw Errors.validation(err);
  if (BRANCH_SCOPED_ROLES.includes(input.role) && !input.branchId) throw Errors.validation("Branch-level roles need a branch");
  const s = await prisma.staff.create({
    data: { username: input.username, email: input.email, fullNameAr: input.fullNameAr, fullNameEn: input.fullNameEn, role: input.role, branchId: input.branchId || null, passwordHash: await hashPassword(input.password) },
  }).catch((e) => {
    if ((e as { code?: string }).code === "P2002") throw Errors.conflict("Username or email already exists");
    throw e;
  });
  await audit(actor, "STAFF_CREATED", { type: "Staff", id: s.id }, undefined, { username: s.username, role: s.role, branchId: s.branchId });
  return { id: s.id, username: s.username };
}

export async function updateStaff(staff: StaffPrincipal, actor: Actor, id: string, raw: unknown) {
  requirePerm(staff, "staff.manage");
  const input = z.object({ role: z.enum(ROLES).optional(), branchId: z.string().nullable().optional(), active: z.boolean().optional(), unlock: z.boolean().optional() }).parse(raw);
  if (id === staff.id && (input.role || input.active === false)) throw new AppError("SELF_CHANGE", 403, "You cannot change your own role or deactivate yourself");
  const before = await prisma.staff.findUnique({ where: { id }, omit: { passwordHash: true, totpSecret: true } });
  if (!before) throw Errors.notFound("Staff");
  const after = await prisma.staff.update({
    where: { id },
    data: { role: input.role, branchId: input.branchId === undefined ? undefined : input.branchId, active: input.active, ...(input.unlock ? { failedLogins: 0, lockedUntil: null } : {}) },
    omit: { passwordHash: true, totpSecret: true },
  });
  if (input.active === false || input.role) await prisma.staffSession.deleteMany({ where: { staffId: id } });
  await audit(actor, "STAFF_UPDATED", { type: "Staff", id }, before, after);
  return after;
}

export async function changeOwnPassword(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(raw);
  const s = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } });
  const bcrypt = await import("bcryptjs");
  if (!(await bcrypt.compare(current, s.passwordHash))) throw new AppError("INVALID_CREDENTIALS", 401, "Current password is wrong");
  const err = checkPasswordPolicy(next);
  if (err) throw Errors.validation(err);
  await prisma.staff.update({ where: { id: staff.id }, data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() } });
  await audit(actor, "STAFF_PASSWORD_CHANGED", { type: "Staff", id: staff.id });
  return { ok: true };
}

export async function totpSetup(staff: StaffPrincipal) {
  const secret = generateTotpSecret();
  await prisma.staff.update({ where: { id: staff.id }, data: { totpSecret: secret, totpEnabled: false } });
  return { secret, otpauthUrl: otpauthUrl(secret, staff.username) };
}

export async function totpEnable(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  const { code } = z.object({ code: z.string() }).parse(raw);
  const s = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } });
  if (!s.totpSecret || !verifyTotp(s.totpSecret, code)) throw new AppError("TOTP_INVALID", 422, "Invalid code");
  await prisma.staff.update({ where: { id: staff.id }, data: { totpEnabled: true } });
  await audit(actor, "STAFF_TOTP_ENABLED", { type: "Staff", id: staff.id });
  return { ok: true };
}

export async function totpDisable(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  const { code } = z.object({ code: z.string() }).parse(raw);
  const s = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } });
  if (!s.totpEnabled || !s.totpSecret || !verifyTotp(s.totpSecret, code)) throw new AppError("TOTP_INVALID", 422, "Invalid code");
  await prisma.staff.update({ where: { id: staff.id }, data: { totpEnabled: false, totpSecret: null } });
  await audit(actor, "STAFF_TOTP_DISABLED", { type: "Staff", id: staff.id });
  return { ok: true };
}

export async function listBranches() {
  return prisma.branch.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { customers: true, accounts: true, staff: true } } } });
}

const branchInput = z.object({ code: z.string().regex(/^\d{4}$/), nameAr: z.string().min(2), nameEn: z.string().min(2), city: z.string().min(2), address: z.string().optional() });

export async function createBranch(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "branch.manage");
  const input = branchInput.parse(raw);
  return withTx(async (tx) => {
    const b = await tx.branch.create({ data: input });
    for (const ccy of ["EGP", "USD", "EUR", "SAR"] as const) {
      await tx.till.create({ data: { code: `${b.code}-VAULT-${ccy}`, branchId: b.id, kind: "VAULT", currency: ccy, status: "OPEN" } });
    }
    await audit(actor, "BRANCH_CREATED", { type: "Branch", id: b.id }, undefined, b, tx);
    return b;
  });
}

export async function assignTill(staff: StaffPrincipal, actor: Actor, raw: unknown) {
  requirePerm(staff, "till.manage");
  const { tellerId, currency } = z.object({ tellerId: z.string(), currency: z.enum(["EGP", "USD", "EUR", "SAR"]) }).parse(raw);
  const teller = await prisma.staff.findUnique({ where: { id: tellerId } });
  if (!teller || !teller.branchId) throw Errors.notFound("Teller");
  if (isBranchScoped(staff) && teller.branchId !== staff.branchId) throw Errors.forbidden();
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: teller.branchId } });
  const t = await prisma.till.create({ data: { code: `${branch.code}-T-${teller.username}-${currency}`, branchId: branch.id, kind: "TELLER", currency, assignedToId: teller.id } });
  await audit(actor, "TILL_ASSIGNED", { type: "Till", id: t.id }, undefined, { teller: teller.username, currency });
  return t;
}
