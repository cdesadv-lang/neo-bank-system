import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
export const GET = staffApi("audit.read", async (req) => {
  const u = new URL(req.url);
  const q = u.searchParams.get("q") ?? undefined;
  return prisma.auditLog.findMany({ where: q ? { OR: [{ action: { contains: q.toUpperCase() } }, { actorName: { contains: q } }, { entityId: q }] } : {}, orderBy: { createdAt: "desc" }, take: 300 });
});
