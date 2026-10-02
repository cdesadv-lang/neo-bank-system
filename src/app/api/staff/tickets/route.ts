import { staffApi } from "@/server/http";
import { listTicketsStaff } from "@/server/services/tickets";
export const GET = staffApi("ticket.read", async (req, { staff }) => listTicketsStaff(staff, new URL(req.url).searchParams.get("status") ?? undefined));
