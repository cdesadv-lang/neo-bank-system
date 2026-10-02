import { staffApi } from "@/server/http";
import { changeOwnPassword } from "@/server/services/admin";
export const POST = staffApi(null, async (req, { staff, actor }) => changeOwnPassword(staff, actor, await req.json()));
