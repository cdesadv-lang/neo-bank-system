import { staffApi } from "@/server/http";
import { getCustomer, updateCustomer } from "@/server/services/customers";
export const GET = staffApi("customer.read", async (_req, { staff, params }) => getCustomer(staff, params.id));
export const PATCH = staffApi("customer.update", async (req, { staff, actor, params }) => updateCustomer(staff, actor, params.id, await req.json()));
