import { staffApi, parseBody } from "@/server/http";
import { z } from "zod";
import { totpSetup, totpEnable, totpDisable } from "@/server/services/admin";
const schema = z.object({ action: z.enum(["SETUP", "ENABLE", "DISABLE"]), code: z.string().optional() });
export const POST = staffApi(null, async (req, { staff, actor }) => {
  const b = await parseBody(req, schema);
  if (b.action === "SETUP") return totpSetup(staff);
  if (b.action === "ENABLE") return totpEnable(staff, actor, b);
  return totpDisable(staff, actor, b);
});
