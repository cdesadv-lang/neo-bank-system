import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
export const GET = portalApi(async (_req, { customer }) => {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customer.customerId }, select: { cif: true, nameAr: true, nameEn: true, phone: true, email: true, address: true, kycStatus: true, type: true, branch: { select: { nameAr: true, nameEn: true } } } });
  return { customer: c };
});
