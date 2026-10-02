import { staffApi } from "@/server/http";
import { staffAuthAction } from "@/server/services/card-auth";
export const POST = staffApi("card.manage", async (req, { staff, actor, params }) => staffAuthAction(staff, actor, params.id, await req.json()));
