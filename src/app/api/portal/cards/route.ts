import { prisma } from "@/lib/db";
import { portalApi } from "@/server/http";
export const GET = portalApi(async (_req, { customer }) => prisma.card.findMany({ where: { customerId: customer.customerId, status: { not: "CANCELLED" } }, include: { account: { select: { accountNumber: true, currency: true } } }, omit: { token: true, pinVerificationValue: true } }));
