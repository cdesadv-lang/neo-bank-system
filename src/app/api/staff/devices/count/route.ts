import { staffApi } from "@/server/http";
import { captureCount } from "@/server/services/cash-count";
/** Pull a count from a cash-counting machine (simulator / TCP / serial driver). */
export const POST = staffApi("till.operate", async (req, { staff, actor }) => captureCount(staff, actor, await req.json()));
