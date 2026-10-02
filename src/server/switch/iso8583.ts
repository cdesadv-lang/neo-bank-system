/**
 * ISO 8583 (1987) style message model, JSON-encoded for the built-in switch.
 * Only the data elements the issuer needs are mapped. A production switch link uses
 * the processor's binary/ASCII spec (bitmaps, length prefixes, MAC) — implement that
 * in a SwitchAdapter; the mapping to the core stays the same.
 *
 *  MTI 0100/0110 authorization (POS/ECOM/contactless hold)
 *  MTI 0200/0210 financial request (ATM withdrawal, balance inquiry, mini-statement)
 *  MTI 0220/0230 completion advice (capture)
 *  MTI 0420/0430 reversal advice (timeout, dispense failure, void)
 *  Processing code (DE 3): 00 purchase, 01 cash withdrawal, 20 refund, 31 balance inquiry, 38 mini-statement
 */
export type IsoMessage = { mti: string; fields: Record<string, string> };

export const DE = {
  PAN_TOKEN: "2", // token in place of PAN — no real PANs in this system
  PROCESSING_CODE: "3",
  AMOUNT: "4",
  TRANSMISSION_TIME: "7",
  STAN: "11",
  MCC: "18",
  ENTRY_MODE: "22",
  ACQUIRER_ID: "32",
  RRN: "37",
  AUTH_CODE: "38",
  RESPONSE_CODE: "39",
  TERMINAL_ID: "41",
  MERCHANT_ID: "42",
  MERCHANT_NAME_LOC: "43",
  ADDITIONAL_DATA: "48", // here: JSON (mini statement, 3DS data)
  CURRENCY: "49",
  PIN_BLOCK: "52",
  ADDITIONAL_AMOUNTS: "54", // available balance
  ORIGINAL_DATA: "90", // original STAN for reversals/refunds/completions
} as const;

export const CURRENCY_NUMERIC: Record<string, string> = { EGP: "818", USD: "840", EUR: "978", SAR: "682" };
export const NUMERIC_CURRENCY: Record<string, "EGP" | "USD" | "EUR" | "SAR"> = { "818": "EGP", "840": "USD", "978": "EUR", "682": "SAR" };

export const ENTRY_MODES: Record<string, string> = { "05": "CHIP", "07": "CONTACTLESS", "81": "ECOM", "90": "MAGSTRIPE", "01": "MANUAL" };

export function amountField(minor: bigint): string {
  return minor.toString().padStart(12, "0");
}

/** DE 43: 22 chars name + 13 chars city + 3 country (ISO alpha) */
export function merchantField(name: string, city = "CAIRO", country = "EG"): string {
  return name.slice(0, 22).padEnd(22) + city.slice(0, 13).padEnd(13) + country.slice(0, 3).padEnd(3);
}

export function parseMerchantField(v?: string): { name: string; city: string; country: string } | undefined {
  if (!v) return undefined;
  return { name: v.slice(0, 22).trim(), city: v.slice(22, 35).trim(), country: (v.slice(35, 38).trim() || "EG").slice(0, 2) };
}
