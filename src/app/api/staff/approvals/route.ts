import { staffApi } from "@/server/http";
import { listApprovals } from "@/server/services/approvals";
export const GET = staffApi("approval.read", async (req, { staff }) => listApprovals(staff, new URL(req.url).searchParams.get("status") ?? "PENDING"));
