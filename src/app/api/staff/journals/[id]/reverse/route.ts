import { staffApi } from "@/server/http";
import { requestReversal } from "@/server/services/journals";
export const POST = staffApi("journal.reverse", async (req, { staff, actor, params }) => requestReversal(staff, actor, params.id, await req.json()));
