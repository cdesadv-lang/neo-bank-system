import { prisma, Tx } from "@/lib/db";
import { jsonSafe } from "@/lib/money";

export type Actor = {
  type: "STAFF" | "CUSTOMER" | "SYSTEM" | "ANONYMOUS";
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export const SYSTEM_ACTOR: Actor = { type: "SYSTEM", name: "system" };

/** Append-only audit trail (UPDATE/DELETE blocked by a DB trigger). */
export async function audit(
  actor: Actor,
  action: string,
  entity: { type?: string; id?: string | null } = {},
  before?: unknown,
  after?: unknown,
  tx?: Tx,
) {
  const db = tx ?? prisma;
  await db.auditLog.create({
    data: {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      action,
      entityType: entity.type ?? null,
      entityId: entity.id ?? null,
      before: before === undefined ? undefined : (jsonSafe(before) as object),
      after: after === undefined ? undefined : (jsonSafe(after) as object),
      ip: actor.ip ?? null,
      userAgent: actor.userAgent?.slice(0, 300) ?? null,
    },
  });
}
