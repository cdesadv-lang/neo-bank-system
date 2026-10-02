import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
import { portalApplyLoan } from "@/server/services/portal";
export const GET = portalApi(async (_req, { customer }) => ({
  loans: await prisma.loan.findMany({ where: { customerId: customer.customerId }, include: { product: true, installments: { orderBy: { seq: "asc" } } }, orderBy: { createdAt: "desc" } }),
  products: await prisma.loanProduct.findMany({ where: { active: true } }),
}));
export const POST = portalApi(async (req, { customer, actor }) => portalApplyLoan(customer, actor, await req.json()));
