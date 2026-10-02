import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { listTills, openTill, moveCash, balanceTill } from "@/server/services/teller";
import { assignTill } from "@/server/services/admin";
export const GET = staffApi("till.read", async (_req, { staff }) => listTills(staff));
const schema = z.object({ action: z.enum(["OPEN", "MOVE", "BALANCE", "ASSIGN"]) }).passthrough();
export const POST = staffApi("till.read", async (req, { staff, actor }) => {
  const b = await parseBody(req, schema);
  if (b.action === "OPEN") return openTill(staff, actor, b);
  if (b.action === "MOVE") return moveCash(staff, actor, b);
  if (b.action === "ASSIGN") return assignTill(staff, actor, b);
  return balanceTill(staff, actor, b);
});
