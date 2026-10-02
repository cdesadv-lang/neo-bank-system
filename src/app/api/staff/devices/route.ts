import { staffApi } from "@/server/http";
import { listDevices, registerDevice } from "@/server/services/cash-count";
export const GET = staffApi("till.read", async (_req, { staff }) => listDevices(staff));
export const POST = staffApi("till.manage", async (req, { staff, actor }) => registerDevice(staff, actor, await req.json()));
