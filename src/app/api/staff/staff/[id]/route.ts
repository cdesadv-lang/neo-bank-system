import { staffApi } from "@/server/http";
import { updateStaff } from "@/server/services/admin";
export const PATCH = staffApi("staff.manage", async (req, { staff, actor, params }) => updateStaff(staff, actor, params.id, await req.json()));
