import { staffApi } from "@/server/http";
import { cashWithdrawal } from "@/server/services/teller";
export const POST = staffApi("cash.withdraw", async (req, { staff, actor }) => cashWithdrawal(staff, actor, await req.json()));
