import { portalApi } from "@/server/http";
import { myAccount } from "@/server/services/portal";
export const GET = portalApi(async (_req, { customer, params }) => myAccount(customer.customerId, params.id));
