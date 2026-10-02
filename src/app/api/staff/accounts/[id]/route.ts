import { staffApi } from "@/server/http";
import { getAccount } from "@/server/services/accounts";
export const GET = staffApi("account.read", async (_req, { staff, params }) => getAccount(staff, params.id));
