import { z } from "zod";
import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { portalApi, parseBody } from "@/server/http";
import { PosSimulator } from "@/server/switch/simulators";
import { defaultSwitch } from "@/server/switch/adapter";
import { toMinor } from "@/lib/money";
/** DEMO merchant checkout (MOCK e-commerce merchant) so customers can try 3-D Secure. */
const schema = z.object({ amount: z.string(), merchantName: z.string().max(22).default("Demo Online Store"), stan: z.string().regex(/^\d{6}$/), threeDs: z.object({ challengeId: z.string(), code: z.string() }).optional() });
export const POST = portalApi(async (req, { customer, params }) => {
  const b = await parseBody(req, schema);
  const card = await prisma.card.findUnique({ where: { id: params.id }, include: { account: true } });
  if (!card || card.customerId !== customer.customerId) throw Errors.notFound("Card");
  const sim = new PosSimulator(defaultSwitch(), { id: "MERDEMOWEB", name: b.merchantName, mcc: "5999", country: "EG" });
  const res = await sim.purchase({ cardToken: card.token, amount: toMinor(b.amount), currency: card.account.currency, mode: "ECOM", threeDs: b.threeDs, stan: b.stan });
  const extra = res.fields["48"] ? JSON.parse(res.fields["48"]) : {};
  return { responseCode: res.fields["39"], rrn: res.fields["37"], challengeId: extra.challengeId, mock: true };
});
