import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { replenishAtm, reconcileAtm, setAtmStatus } from "@/server/services/atm";
const schema = z.object({ action: z.enum(["REPLENISH", "RECONCILE", "STATUS"]), status: z.string().optional() }).passthrough();
export const POST = staffApi("atm.manage", async (req, { staff, actor, params }) => {
  const b = await parseBody(req, schema);
  if (b.action === "REPLENISH") return replenishAtm(staff, actor, { ...b, atmId: params.id });
  if (b.action === "RECONCILE") return reconcileAtm(staff, actor, { ...b, atmId: params.id });
  return setAtmStatus(staff, actor, params.id, b.status ?? "");
});
