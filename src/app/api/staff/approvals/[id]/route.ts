import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { decideApproval } from "@/server/services/approvals";
export const POST = staffApi("approval.decide", async (req, { staff, actor, params }) => {
  const b = await parseBody(req, z.object({ decision: z.enum(["APPROVE", "REJECT"]), comment: z.string().max(500).optional() }));
  return decideApproval(staff, actor, params.id, b.decision, b.comment);
});
