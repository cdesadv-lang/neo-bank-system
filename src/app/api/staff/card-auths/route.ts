import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
import { branchWhere } from "@/server/rbac";
export const GET = staffApi("card.read", async (req, { staff }) => {
  const u = new URL(req.url);
  return prisma.cardAuthorization.findMany({
    where: { card: { account: branchWhere(staff) }, ...(u.searchParams.get("status") ? { status: u.searchParams.get("status")! } : {}), ...(u.searchParams.get("channel") ? { channel: u.searchParams.get("channel")! } : {}), ...(u.searchParams.get("cardId") ? { cardId: u.searchParams.get("cardId")! } : {}) },
    include: { card: { select: { maskedPan: true, customer: { select: { nameEn: true, nameAr: true, cif: true } } } }, events: true },
    orderBy: { createdAt: "desc" }, take: 200,
  });
});
