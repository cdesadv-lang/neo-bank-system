import type { Prisma } from "@prisma/client";
import { prisma, withTx } from "@/lib/db";
import { AppError, Errors } from "@/lib/errors";
import { jsonSafe } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";
import { CHECKER_ROLES, isBranchScoped, requirePerm, type StaffPrincipal } from "@/server/rbac";
import { executeKycApproval } from "./customers";
import { executeStatusChange } from "./accounts";
import { executeManualJournal, executeReversal } from "./journals";
import { executeLargeCash } from "./teller";
import { executeCardUnblock } from "./cards";

export async function listApprovals(staff: StaffPrincipal, status = "PENDING") {
  requirePerm(staff, "approval.read");
  const where: Prisma.ApprovalRequestWhereInput = { status };
  if (isBranchScoped(staff)) where.branchId = staff.branchId;
  return prisma.approvalRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
}

/**
 * Maker-checker decision. Enforced rules:
 *  - checker must hold approval.decide and be in CHECKER_ROLES for the request type
 *  - checker can never be the maker (four-eyes)
 *  - branch-scoped checkers can only decide their own branch's requests
 */
export async function decideApproval(staff: StaffPrincipal, actor: Actor, id: string, decision: "APPROVE" | "REJECT", comment?: string) {
  requirePerm(staff, "approval.decide");
  const req = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!req) throw Errors.notFound("Approval request");
  if (req.status !== "PENDING") throw new AppError("INVALID_STATE", 409, "Request already decided");
  if (req.makerId === staff.id) throw new AppError("FOUR_EYES_VIOLATION", 403, "Maker cannot approve their own request");
  if (!CHECKER_ROLES[req.type]?.includes(staff.role)) throw Errors.forbidden(`Role ${staff.role} cannot check ${req.type}`);
  if (isBranchScoped(staff) && req.branchId && req.branchId !== staff.branchId) throw Errors.forbidden("Request belongs to another branch");

  // claim atomically so two checkers can't both execute
  const claimed = await prisma.approvalRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "PROCESSING", checkerId: staff.id } });
  if (claimed.count !== 1) throw new AppError("INVALID_STATE", 409, "Request already being decided");

  const payload = req.payload as Record<string, unknown>;
  try {
    let result: unknown = null;
    if (decision === "APPROVE") {
      switch (req.type) {
        case "KYC_APPROVAL":
          result = await withTx((tx) => executeKycApproval(tx, payload as { customerId: string }, staff, actor, true));
          break;
        case "ACCOUNT_STATUS":
          result = await withTx((tx) => executeStatusChange(tx, payload as never, actor));
          break;
        case "MANUAL_JOURNAL":
          result = await executeManualJournal(req.id, payload as never, staff, actor);
          break;
        case "JOURNAL_REVERSAL":
          result = await executeReversal(payload as never, staff, actor);
          break;
        case "LARGE_CASH":
          result = await executeLargeCash(payload as never, staff, actor);
          break;
        case "CARD_UNBLOCK":
          result = await executeCardUnblock(payload as never, actor);
          break;
        default:
          throw Errors.validation(`Unknown approval type ${req.type}`);
      }
    } else if (req.type === "KYC_APPROVAL") {
      result = await withTx((tx) => executeKycApproval(tx, payload as { customerId: string }, staff, actor, false, comment));
    }
    const done = await prisma.approvalRequest.update({
      where: { id },
      data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedAt: new Date(), comment, result: jsonSafe({ ok: true, result }) as object },
    });
    await audit(actor, decision === "APPROVE" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED", { type: "ApprovalRequest", id }, { status: "PENDING" }, { status: done.status, type: req.type, comment });
    return done;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.approvalRequest.update({ where: { id }, data: { status: "FAILED", decidedAt: new Date(), comment: comment ?? null, result: { ok: false, error: msg } } });
    await audit(actor, "APPROVAL_FAILED", { type: "ApprovalRequest", id }, undefined, { error: msg });
    throw e;
  }
}
