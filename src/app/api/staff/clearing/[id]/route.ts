import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { submitBatch, settleBatch } from "@/server/services/transfers";
export const POST = staffApi("clearing.manage", async (req, { staff, actor, params }) => {
  const { action } = await parseBody(req, z.object({ action: z.enum(["SUBMIT", "SETTLE"]) }));
  return action === "SUBMIT" ? submitBatch(staff, actor, params.id) : settleBatch(staff, actor, params.id);
});
