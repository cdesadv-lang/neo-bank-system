import type { StaffRole } from "@prisma/client";
import { Errors } from "@/lib/errors";

export const PERMISSIONS = [
  "dashboard.read",
  "customer.read", "customer.create", "customer.update", "kyc.approve",
  "account.read", "account.open", "account.status",
  "cash.deposit", "cash.withdraw", "till.read", "till.operate", "till.manage",
  "transfer.create", "clearing.manage",
  "loan.read", "loan.apply", "loan.recommend", "loan.approve", "loan.disburse", "loan.repay",
  "deposit.open",
  "card.read", "card.manage", "card.dispute",
  "atm.read", "atm.manage",
  "fee.manage",
  "aml.read", "aml.manage",
  "gl.read", "journal.read", "journal.manual", "journal.reverse",
  "report.read", "eod.run",
  "approval.read", "approval.decide",
  "audit.read",
  "staff.read", "staff.manage", "branch.manage",
  "ticket.read", "ticket.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = PERMISSIONS.filter((p) => p.endsWith(".read"));

export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  SUPER_ADMIN: [...PERMISSIONS],
  BRANCH_MANAGER: [
    "dashboard.read", "customer.read", "customer.create", "customer.update", "kyc.approve",
    "account.read", "account.open", "account.status", "cash.deposit", "cash.withdraw", "till.read", "till.operate", "till.manage",
    "transfer.create", "loan.read", "loan.apply", "loan.repay", "deposit.open", "card.read", "card.manage", "card.dispute", "atm.read", "atm.manage",
    "report.read", "approval.read", "approval.decide", "staff.read", "ticket.read", "ticket.manage", "journal.read",
  ],
  TELLER: ["dashboard.read", "customer.read", "account.read", "cash.deposit", "cash.withdraw", "till.read", "till.operate", "transfer.create", "loan.repay", "atm.read"],
  CUSTOMER_SERVICE: [
    "dashboard.read", "customer.read", "customer.create", "customer.update", "account.read", "account.open", "account.status",
    "card.read", "card.manage", "card.dispute",
  "atm.read", "atm.manage", "deposit.open", "loan.read", "loan.apply", "ticket.read", "ticket.manage", "approval.read",
  ],
  CREDIT_OFFICER: ["dashboard.read", "customer.read", "account.read", "loan.read", "loan.apply", "loan.recommend", "loan.repay", "report.read"],
  CREDIT_MANAGER: ["dashboard.read", "customer.read", "account.read", "loan.read", "loan.approve", "loan.disburse", "report.read"],
  COMPLIANCE_OFFICER: [
    "dashboard.read", "customer.read", "kyc.approve", "account.read", "account.status", "aml.read", "aml.manage",
    "approval.read", "approval.decide", "audit.read", "report.read", "journal.read", "ticket.read",
  ],
  OPERATIONS: [
    "dashboard.read", "customer.read", "account.read", "account.status", "transfer.create", "clearing.manage", "eod.run",
    "card.read", "card.manage", "card.dispute",
  "atm.read", "atm.manage", "approval.read", "approval.decide", "report.read", "journal.read", "till.read", "ticket.read", "ticket.manage",
  ],
  FINANCE: [
    "dashboard.read", "gl.read", "journal.read", "journal.manual", "journal.reverse", "report.read", "fee.manage",
    "approval.read", "approval.decide", "eod.run", "account.read", "customer.read", "till.read", "loan.read",
  ],
  AUDITOR: READ_ALL,
};

/** Roles whose data access is limited to their own branch. */
export const BRANCH_SCOPED_ROLES: StaffRole[] = ["BRANCH_MANAGER", "TELLER", "CUSTOMER_SERVICE", "CREDIT_OFFICER"];

/** Which roles may act as CHECKER for each maker-checker request type. */
export const CHECKER_ROLES: Record<string, StaffRole[]> = {
  KYC_APPROVAL: ["SUPER_ADMIN", "BRANCH_MANAGER", "COMPLIANCE_OFFICER"],
  ACCOUNT_STATUS: ["SUPER_ADMIN", "BRANCH_MANAGER", "COMPLIANCE_OFFICER", "OPERATIONS"],
  JOURNAL_REVERSAL: ["SUPER_ADMIN", "FINANCE"],
  MANUAL_JOURNAL: ["SUPER_ADMIN", "FINANCE"],
  LARGE_CASH: ["SUPER_ADMIN", "BRANCH_MANAGER"],
  CARD_UNBLOCK: ["SUPER_ADMIN", "BRANCH_MANAGER", "OPERATIONS"],
};

export type StaffPrincipal = {
  id: string;
  username: string;
  role: StaffRole;
  branchId: string | null;
  fullNameEn: string;
  fullNameAr: string;
};

export function can(staff: Pick<StaffPrincipal, "role">, perm: Permission): boolean {
  return ROLE_PERMISSIONS[staff.role].includes(perm);
}

export function requirePerm(staff: Pick<StaffPrincipal, "role">, perm: Permission) {
  if (!can(staff, perm)) throw Errors.forbidden(`Role ${staff.role} lacks permission ${perm}`);
}

export function isBranchScoped(staff: Pick<StaffPrincipal, "role">): boolean {
  return BRANCH_SCOPED_ROLES.includes(staff.role);
}

/** Prisma where-fragment restricting rows to the staff member's branch (empty for HQ roles). */
export function branchWhere(staff: Pick<StaffPrincipal, "role" | "branchId">): { branchId?: string } {
  if (!isBranchScoped(staff)) return {};
  return { branchId: staff.branchId ?? "__none__" };
}

export function assertBranchAccess(staff: Pick<StaffPrincipal, "role" | "branchId">, branchId: string | null | undefined) {
  if (!isBranchScoped(staff)) return;
  if (!branchId || branchId !== staff.branchId) throw Errors.forbidden("Record belongs to another branch");
}
