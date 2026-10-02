import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { setRiskRating } from "@/server/services/customers";
export const POST = staffApi("customer.read", async (req, { staff, actor, params }) => {
  const { riskRating } = await parseBody(req, z.object({ riskRating: z.enum(["LOW", "MEDIUM", "HIGH"]) }));
  return setRiskRating(staff, actor, params.id, riskRating);
});
