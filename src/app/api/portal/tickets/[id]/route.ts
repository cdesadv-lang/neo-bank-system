import { portalApi } from "@/server/http";
import { customerReply } from "@/server/services/tickets";
export const POST = portalApi(async (req, { customer, params }) => customerReply(customer.customerId, customer.nameEn, params.id, await req.json()));
