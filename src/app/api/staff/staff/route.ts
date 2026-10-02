import { staffApi } from "@/server/http";
import { listStaff, createStaff } from "@/server/services/admin";
export const GET = staffApi("staff.read", async (_req, { staff }) => listStaff(staff));
export const POST = staffApi("staff.manage", async (req, { staff, actor }) => createStaff(staff, actor, await req.json()));
