import { staffApi } from "@/server/http";
import { listAlerts } from "@/server/services/aml";
export const GET = staffApi("aml.read", async (req, { staff }) => listAlerts(staff, { status: new URL(req.url).searchParams.get("status") ?? undefined }));
