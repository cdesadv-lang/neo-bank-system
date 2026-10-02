import { z } from "zod";
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { staffApi, parseBody } from "@/server/http";
import { audit } from "@/server/audit";
import { AtmSimulator } from "@/server/switch/simulators";
import { InProcessSwitch, TimeoutReversalSwitch } from "@/server/switch/adapter";
import { toMinor } from "@/lib/money";
import { assertBranchAccess } from "@/server/rbac";
/** Built-in ATM simulator (staff demo/testing). The card token is resolved server-side and never sent to the browser. */
const schema = z.object({ terminalId: z.string(), cardId: z.string(), pin: z.string().regex(/^\d{4,6}$/), op: z.enum(["WITHDRAW", "BALANCE", "MINI", "WITHDRAW_DISPENSE_FAULT", "WITHDRAW_TIMEOUT"]), amount: z.string().optional() });
export const POST = staffApi("atm.manage", async (req, { staff, actor }) => {
  const b = await parseBody(req, schema);
  const card = await prisma.card.findUnique({ where: { id: b.cardId }, include: { account: true } });
  if (!card) throw Errors.notFound("Card");
  const atm = await prisma.atmTerminal.findUnique({ where: { terminalId: b.terminalId } });
  if (!atm) throw Errors.notFound("ATM");
  assertBranchAccess(staff, atm.branchId);
  const sw = b.op === "WITHDRAW_TIMEOUT" ? new TimeoutReversalSwitch(new InProcessSwitch(300), 50) : new TimeoutReversalSwitch(new InProcessSwitch(), 30_000);
  const sim = new AtmSimulator(b.terminalId, sw);
  let res;
  if (b.op === "BALANCE") res = await sim.balance(card.token, b.pin, card.account.currency);
  else if (b.op === "MINI") res = await sim.miniStatement(card.token, b.pin, card.account.currency);
  else {
    res = await sim.withdraw(card.token, b.pin, toMinor(b.amount ?? "0"), card.account.currency);
    if (b.op === "WITHDRAW_DISPENSE_FAULT" && res.fields["39"] === "00") {
      const rev = await sim.dispenseFault({ mti: "0200", fields: { ...res.fields, "2": card.token } });
      res = { ...res, reversal: rev };
    }
  }
  await audit(actor, "ATM_SIMULATOR", { type: "AtmTerminal", id: atm.id }, undefined, { op: b.op, response: res.fields["39"] });
  const { ["2"]: _tok, ["52"]: _pin, ...safe } = res.fields; void _tok; void _pin;
  return { mti: res.mti, fields: safe, ...("reversal" in res ? { reversal: (res as { reversal: { mti: string; fields: Record<string, string> } }).reversal.fields["39"] } : {}) };
});
