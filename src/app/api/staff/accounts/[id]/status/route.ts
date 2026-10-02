import { staffApi } from "@/server/http";
import { requestStatusChange } from "@/server/services/accounts";
export const POST = staffApi("account.status", async (req, { staff, actor, params }) => requestStatusChange(staff, actor, params.id, await req.json()));
