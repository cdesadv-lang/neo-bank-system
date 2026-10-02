import { portalApi } from "@/server/http";
import { openDisputeByCustomer } from "@/server/services/card-auth";
export const POST = portalApi(async (req, { customer, actor }) => openDisputeByCustomer(customer.customerId, actor, await req.json()));
