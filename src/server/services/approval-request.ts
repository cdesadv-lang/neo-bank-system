import { prisma, Tx } from "@/lib/db";
import { jsonSafe } from "@/lib/money";
import { audit, type Actor } from "@/server/audit";

export async function createApproval(
  db: Tx | typeof prisma,
  actor: Actor,
  input: { type: string; summary: string; payload: unknown; makerId: string; entityType?: string; entityId?: string; branchId?: string | null },
) {
  const req = await db.approvalRequest.create({
    data: {
      type: input.type,
      summary: input.summary,
      payload: jsonSafe(input.payload) as object,
      makerId: input.makerId,
      entityType: input.entityType,
      entityId: input.entityId,
      branchId: input.branchId ?? null,
    },
  });
  await audit(actor, "APPROVAL_REQUESTED", { type: "ApprovalRequest", id: req.id }, undefined, { type: req.type, summary: req.summary }, db as Tx);
  return req;
}
