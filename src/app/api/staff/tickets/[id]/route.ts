import { staffApi } from "@/server/http";
import { staffTicketAction } from "@/server/services/tickets";
export const POST = staffApi("ticket.manage", async (req, { staff, actor, params }) => staffTicketAction(staff, actor, params.id, await req.json()));
