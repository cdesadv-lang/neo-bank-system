import { staffApi } from "@/server/http";
import { listCases, openCase } from "@/server/services/aml";
export const GET = staffApi("aml.read", async (_req, { staff }) => listCases(staff));
export const POST = staffApi("aml.manage", async (req, { staff, actor }) => openCase(staff, actor, await req.json()));
