import { staffApi } from "@/server/http";
import { openTermDeposit } from "@/server/services/deposits";
export const POST = staffApi("deposit.open", async (req, { staff, actor, params }) => openTermDeposit(staff, actor, params.id, await req.json()));
