import { staffApi } from "@/server/http";
import { disputeAction } from "@/server/services/card-auth";
export const POST = staffApi("card.dispute", async (req, { staff, actor, params }) => disputeAction(staff, actor, params.id, await req.json()));
