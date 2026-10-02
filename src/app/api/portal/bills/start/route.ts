import { portalApi } from "@/server/http";
import { startBillPayment } from "@/server/services/portal";
export const POST = portalApi(async (req, { customer }) => startBillPayment(customer, await req.json()));
