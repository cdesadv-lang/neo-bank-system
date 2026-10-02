import { z } from "zod";
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { staffApi, parseBody } from "@/server/http";
import { audit } from "@/server/audit";
import { PosSimulator } from "@/server/switch/simulators";
import { defaultSwitch } from "@/server/switch/adapter";
import { toMinor } from "@/lib/money";
/** POS / e-commerce / contactless purchase simulator (acquirer side). */
const schema = z.object({
  cardId: z.string(), mode: z.enum(["CHIP", "CONTACTLESS", "ECOM"]), amount: z.string(), pin: z.string().optional(),
  merchantName: z.string().default("Demo Supermarket"), mcc: z.string().default("5411"), country: z.string().length(2).default("EG"),
  threeDs: z.object({ challengeId: z.string(), code: z.string() }).optional(), stan: z.string().optional(),
});
export const POST = staffApi("card.manage", async (req, { actor }) => {
  const b = await parseBody(req, schema);
  const card = await prisma.card.findUnique({ where: { id: b.cardId }, include: { account: true } });
  if (!card) throw Errors.notFound("Card");
  const sim = new PosSimulator(defaultSwitch(), { id: `MER${b.merchantName.replace(/\W/g, "").slice(0, 8).toUpperCase()}`, name: b.merchantName, mcc: b.mcc, country: b.country, city: "CAIRO" });
  const res = await sim.purchase({ cardToken: card.token, amount: toMinor(b.amount), currency: card.account.currency, mode: b.mode, pin: b.pin, threeDs: b.threeDs, stan: b.stan });
  await audit(actor, "POS_SIMULATOR", { type: "Card", id: card.id }, undefined, { mode: b.mode, response: res.fields["39"] });
  const { ["2"]: _tok, ["52"]: _pin, ...safe } = res.fields; void _tok; void _pin;
  return { mti: res.mti, fields: safe };
});
