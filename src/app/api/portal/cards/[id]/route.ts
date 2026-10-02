import { portalApi } from "@/server/http";
import { customerUpdateCard } from "@/server/services/cards";
export const POST = portalApi(async (req, { customer, actor, params }) => customerUpdateCard(customer.customerId, actor, params.id, await req.json()));
