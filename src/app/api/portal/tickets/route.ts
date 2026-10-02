import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
import { createTicket } from "@/server/services/tickets";
export const GET = portalApi(async (_req, { customer }) => prisma.supportTicket.findMany({ where: { customerId: customer.customerId }, include: { messages: { orderBy: { createdAt: "asc" } } }, orderBy: { updatedAt: "desc" } }));
export const POST = portalApi(async (req, { customer, actor }) => createTicket(customer.customerId, customer.nameEn, actor, await req.json()));
