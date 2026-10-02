import Decimal from "decimal.js";
import type { Currency } from "@prisma/client";
import { prisma, Tx } from "@/lib/db";
import { roundMinor } from "@/lib/money";

/** Fees engine: fixed + percentage (bps), bounded by min/max, per event & currency. */
export async function computeFee(db: Tx | typeof prisma, event: string, amount: bigint, currency: Currency): Promise<{ fee: bigint; ruleCode?: string }> {
  const rule = await db.feeRule.findFirst({ where: { event, currency, active: true } });
  if (!rule) return { fee: 0n };
  let fee = rule.fixedAmount + roundMinor(new Decimal(amount.toString()).mul(rule.rateBps).div(10000));
  if (fee < rule.minAmount) fee = rule.minAmount;
  if (rule.maxAmount != null && fee > rule.maxAmount) fee = rule.maxAmount;
  return { fee, ruleCode: rule.code };
}
