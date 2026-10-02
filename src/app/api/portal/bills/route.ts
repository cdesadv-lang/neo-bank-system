import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
import { MockBillerAdapter } from "@/server/services/billers";
import { billInquiry } from "@/server/services/portal";
export const GET = portalApi(async (req, { customer }) => {
  const u = new URL(req.url);
  if (u.searchParams.get("billerCode") && u.searchParams.get("reference")) return billInquiry(u.searchParams.get("billerCode")!, u.searchParams.get("reference")!);
  return { mock: true, billers: MockBillerAdapter.list(), history: await prisma.billPayment.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" }, take: 50 }) };
});
