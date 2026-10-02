import { staffApi } from "@/server/http";
import { updateAlert } from "@/server/services/aml";
export const POST = staffApi("aml.manage", async (req, { staff, actor, params }) => updateAlert(staff, actor, params.id, await req.json()));
