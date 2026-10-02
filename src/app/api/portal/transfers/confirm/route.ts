import { portalApi } from "@/server/http";
import { confirmTransfer } from "@/server/services/portal";
export const POST = portalApi(async (req, { customer, actor }) => confirmTransfer(customer, actor, await req.json()));
