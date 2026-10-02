import { portalApi } from "@/server/http";
import { startTransfer } from "@/server/services/portal";
export const POST = portalApi(async (req, { customer }) => startTransfer(customer, await req.json()));
