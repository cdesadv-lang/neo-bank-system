import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { portalApi } from "@/server/http";
export const GET = portalApi(async (_req, { customer, params }) => {
  const card = await prisma.card.findUnique({ where: { id: params.id } });
  if (!card || card.customerId !== customer.customerId) throw Errors.notFound("Card");
  return prisma.cardAuthorization.findMany({ where: { cardId: card.id }, orderBy: { createdAt: "desc" }, take: 100, include: { disputes: true } });
});
