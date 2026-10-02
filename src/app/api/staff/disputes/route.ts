import { staffApi } from "@/server/http";
import { listDisputes, openDisputeByStaff } from "@/server/services/card-auth";
export const GET = staffApi("card.read", async (_req, { staff }) => listDisputes(staff));
export const POST = staffApi("card.dispute", async (req, { staff, actor }) => openDisputeByStaff(staff, actor, await req.json()));
