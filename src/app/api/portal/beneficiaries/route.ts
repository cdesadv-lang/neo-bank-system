import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
import { addBeneficiary } from "@/server/services/portal";
export const GET = portalApi(async (_req, { customer }) => prisma.beneficiary.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" } }));
export const POST = portalApi(async (req, { customer, actor }) => addBeneficiary(customer, actor, await req.json()));
