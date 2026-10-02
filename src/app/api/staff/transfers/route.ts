import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
import { executeTransfer } from "@/server/services/transfers";
import { branchWhere } from "@/server/rbac";
export const GET = staffApi("account.read", async (_req, { staff }) => {
  const bw = branchWhere(staff);
  const ids = bw.branchId ? (await prisma.account.findMany({ where: bw, select: { id: true } })).map((a) => a.id) : undefined;
  return prisma.transfer.findMany({ where: ids ? { fromAccountId: { in: ids } } : {}, orderBy: { createdAt: "desc" }, take: 200 });
});
export const POST = staffApi("transfer.create", async (req, { staff, actor }) => executeTransfer({ kind: "STAFF", staff, actor }, await req.json()));
