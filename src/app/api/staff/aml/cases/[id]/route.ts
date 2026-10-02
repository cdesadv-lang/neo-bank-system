import { staffApi } from "@/server/http";
import { getCase, caseAction } from "@/server/services/aml";
export const GET = staffApi("aml.read", async (_req, { staff, params }) => getCase(staff, params.id));
export const POST = staffApi("aml.manage", async (req, { staff, actor, params }) => caseAction(staff, actor, params.id, await req.json()));
