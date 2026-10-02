import { staffApi } from "@/server/http";
import { cashDeposit } from "@/server/services/teller";
export const POST = staffApi("cash.deposit", async (req, { staff, actor }) => cashDeposit(staff, actor, await req.json()));
