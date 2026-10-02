import Decimal from "decimal.js";
/**
 * Indicative reference rates (EGP per 1 unit) used ONLY for AML thresholds and
 * reporting equivalents. Not a dealing rate. Replace with a treasury feed in production.
 */
export const REFERENCE_RATES: Record<string, string> = { EGP: "1", USD: "48.50", EUR: "53.20", SAR: "12.93" };

export function toEgpEquivalent(amountMinor: bigint, currency: string): bigint {
  const r = new Decimal(REFERENCE_RATES[currency] ?? "1");
  return BigInt(new Decimal(amountMinor.toString()).mul(r).toDecimalPlaces(0).toFixed(0));
}
