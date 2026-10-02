import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
export const GET = portalApi(async (_req, { customer }) => {
  const ids = (await prisma.account.findMany({ where: { customerId: customer.customerId }, select: { id: true } })).map((a) => a.id);
  return prisma.transfer.findMany({ where: { fromAccountId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 100 });
});
