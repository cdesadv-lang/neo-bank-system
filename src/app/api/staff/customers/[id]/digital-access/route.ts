import { staffApi } from "@/server/http";
import { enableDigitalBanking } from "@/server/services/customers";
export const POST = staffApi("customer.update", async (req, { staff, actor, params }) => enableDigitalBanking(staff, actor, params.id, await req.json()));
