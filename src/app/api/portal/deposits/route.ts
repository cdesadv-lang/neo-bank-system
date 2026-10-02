import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
import { portalOpenTd } from "@/server/services/portal";
import { TD_RATES, TD_MIN } from "@/server/services/deposits";
export const GET = portalApi(async (_req, { customer }) => ({
  rates: TD_RATES, minimums: TD_MIN,
  deposits: await prisma.termDeposit.findMany({ where: { account: { customerId: customer.customerId } }, include: { account: true }, orderBy: { createdAt: "desc" } }),
}));
export const POST = portalApi(async (req, { customer, actor }) => portalOpenTd(customer, actor, await req.json()));
