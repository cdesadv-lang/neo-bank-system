import { portalApi } from "@/server/http";
import { myAccounts } from "@/server/services/portal";
export const GET = portalApi(async (_req, { customer }) => myAccounts(customer.customerId));
