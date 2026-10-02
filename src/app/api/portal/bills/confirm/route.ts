import { portalApi } from "@/server/http";
import { confirmBillPayment } from "@/server/services/portal";
export const POST = portalApi(async (req, { customer, actor }) => confirmBillPayment(customer, actor, await req.json()));
