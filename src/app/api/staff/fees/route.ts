import { z } from "zod";
import { prisma } from "@/lib/db";
import { staffApi, parseBody } from "@/server/http";
import { toMinor } from "@/lib/money";
import { audit } from "@/server/audit";
export const GET = staffApi("report.read", async () => prisma.feeRule.findMany({ orderBy: { code: "asc" } }));
const schema = z.object({ id: z.string(), fixedAmount: z.string().optional(), rateBps: z.coerce.number().int().min(0).max(10000).optional(), minAmount: z.string().optional(), maxAmount: z.string().nullable().optional(), active: z.boolean().optional() });
export const PATCH = staffApi("fee.manage", async (req, { actor }) => {
  const b = await parseBody(req, schema);
  const before = await prisma.feeRule.findUniqueOrThrow({ where: { id: b.id } });
  const after = await prisma.feeRule.update({ where: { id: b.id }, data: {
    fixedAmount: b.fixedAmount !== undefined ? toMinor(b.fixedAmount) : undefined, rateBps: b.rateBps, minAmount: b.minAmount !== undefined ? toMinor(b.minAmount) : undefined,
    maxAmount: b.maxAmount === undefined ? undefined : b.maxAmount === null ? null : toMinor(b.maxAmount), active: b.active } });
  await audit(actor, "FEE_RULE_UPDATED", { type: "FeeRule", id: b.id }, before, after);
  return after;
});
