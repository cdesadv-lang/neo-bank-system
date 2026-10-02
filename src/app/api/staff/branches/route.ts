import { staffApi } from "@/server/http";
import { listBranches, createBranch } from "@/server/services/admin";
export const GET = staffApi(null, async () => listBranches());
export const POST = staffApi("branch.manage", async (req, { staff, actor }) => createBranch(staff, actor, await req.json()));
