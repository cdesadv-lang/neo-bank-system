import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
import { executeTransfer } from "@/server/services/transfers";
import { branchWhere } from "@/server/rbac";
export const GET = staffApi("account.read", async (_req, { staff }) => {
  const bw = branchWhere(staff);
  const ids = bw.branchId ? (await prisma.account.findMany({ where: bw, select: { id: true } })).map((a) => a.id) : undefined;
  return prisma.transfer.findMany({ where: ids ? { fromAccountId: { in: ids } } : {}, orderBy: { createdAt: "desc" }, take: 200 });
});
export const POST = staffApi("transfer.create", async (req, { staff, actor }) => {
  const body = (await req.json()) as Record<string, unknown>;
  // staff may key the source IBAN instead of the internal id
  if (typeof body.fromAccountId === "string" && /^EG/i.test(body.fromAccountId.replace(/\s/g, ""))) {
    const a = await prisma.account.findUnique({ where: { accountNumber: body.fromAccountId.replace(/\s/g, "").toUpperCase() } });
    if (a) body.fromAccountId = a.id;
  }
  return executeTransfer({ kind: "STAFF", staff, actor }, body);
});
