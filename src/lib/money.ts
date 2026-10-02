import Decimal from "decimal.js";

export const CURRENCIES = ["EGP", "USD", "EUR", "SAR"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** All supported currencies use 2 decimal places (minor unit = 1/100). */
export const MINOR = 100n;

/** Parse a user-entered decimal string ("1,234.50") into integer minor units. Never uses floats. */
export function toMinor(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input * MINOR;
  const s = String(input).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * MINOR + BigInt((frac + "00").slice(0, 2));
}

/** Format minor units as a plain decimal string, e.g. 123456n -> "1234.56" */
export function minorToString(v: bigint | number | string): string {
  const n = BigInt(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const s = `${a / MINOR}.${(a % MINOR).toString().padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

export function formatMoney(v: bigint | number | string, currency: string = "EGP", locale: "ar" | "en" = "en"): string {
  const s = minorToString(v);
  const [w, f] = s.replace("-", "").split(".");
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = s.startsWith("-") ? "-" : "";
  const sym: Record<string, string> = locale === "ar"
    ? { EGP: "ج.م", USD: "$", EUR: "€", SAR: "ر.س" }
    : { EGP: "EGP", USD: "USD", EUR: "EUR", SAR: "SAR" };
  return `${sign}${grouped}.${f} ${sym[currency] ?? currency}`;
}

/** Round a Decimal (in minor units) half-up to an integer bigint. */
export function roundMinor(d: Decimal): bigint {
  return BigInt(d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

export function floorMinor(d: Decimal): bigint {
  return BigInt(d.toDecimalPlaces(0, Decimal.ROUND_FLOOR).toFixed(0));
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return roundMinor(new Decimal(amount.toString()).mul(bps).div(10000));
}

/** JSON replacer: BigInt -> string. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
