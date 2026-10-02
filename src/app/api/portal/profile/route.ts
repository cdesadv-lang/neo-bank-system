import { z } from "zod";
import { prisma } from "@/lib/db";
import { portalApi, parseBody } from "@/server/http";
import { audit } from "@/server/audit";
export const PATCH = portalApi(async (req, { customer, actor }) => {
  const b = await parseBody(req, z.object({ email: z.string().email().optional(), address: z.string().min(5).max(300).optional() }));
  const before = await prisma.customer.findUniqueOrThrow({ where: { id: customer.customerId }, select: { email: true, address: true } });
  const after = await prisma.customer.update({ where: { id: customer.customerId }, data: b, select: { email: true, address: true } });
  await audit(actor, "CUSTOMER_PROFILE_UPDATED", { type: "Customer", id: customer.customerId }, before, after);
  return after;
});
