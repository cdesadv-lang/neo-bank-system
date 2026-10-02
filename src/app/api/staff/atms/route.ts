import { staffApi } from "@/server/http";
import { listAtms, createAtm } from "@/server/services/atm";
export const GET = staffApi("atm.read", async (_req, { staff }) => listAtms(staff));
export const POST = staffApi("atm.manage", async (req, { staff, actor }) => createAtm(staff, actor, await req.json()));
