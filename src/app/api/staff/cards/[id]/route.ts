import { staffApi } from "@/server/http";
import { staffCardAction } from "@/server/services/cards";
export const POST = staffApi("card.manage", async (req, { staff, actor, params }) => staffCardAction(staff, actor, params.id, await req.json()));
