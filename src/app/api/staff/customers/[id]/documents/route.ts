import { staffApi } from "@/server/http";
import { addKycDocument } from "@/server/services/customers";
export const POST = staffApi("customer.update", async (req, { staff, actor, params }) => addKycDocument(staff, actor, params.id, await req.json()));
