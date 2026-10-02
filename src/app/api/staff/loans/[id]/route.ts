import { z } from "zod";
import { staffApi, parseBody } from "@/server/http";
import { getLoan, loanDecision, disburseLoan, repayLoan } from "@/server/services/loans";
export const GET = staffApi("loan.read", async (_req, { staff, params }) => getLoan(staff, params.id));
const schema = z.object({ action: z.enum(["RECOMMEND", "APPROVE", "REJECT", "DISBURSE", "REPAY"]) }).passthrough();
export const POST = staffApi(null, async (req, { staff, actor, params }) => {
  const b = await parseBody(req, schema);
  if (b.action === "DISBURSE") return disburseLoan(staff, actor, params.id);
  if (b.action === "REPAY") return repayLoan(staff, actor, params.id, b);
  return loanDecision(staff, actor, params.id, b);
});
