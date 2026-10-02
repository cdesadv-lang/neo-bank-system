import { z } from "zod";
import { prisma } from "@/lib/db";
import { portalApi, parseBody } from "@/server/http";
export const GET = portalApi(async (_req, { customer }) => prisma.notification.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" }, take: 100 }));
export const POST = portalApi(async (req, { customer }) => {
  const b = await parseBody(req, z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }));
  const r = await prisma.notification.updateMany({ where: { customerId: customer.customerId, ...(b.all ? {} : { id: { in: b.ids ?? [] } }) }, data: { read: true } });
  return { updated: r.count };
});
