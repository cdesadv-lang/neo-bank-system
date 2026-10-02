import { randomInt } from "crypto";
import { getHsm } from "@/server/cards/hsm";
import { DE, CURRENCY_NUMERIC, amountField, merchantField, type IsoMessage } from "./iso8583";
import type { SwitchAdapter } from "./adapter";

let stanCounter = randomInt(0, 900000);
export function nextStan(): string {
  stanCounter = (stanCounter + 1) % 1_000_000;
  return String(stanCounter).padStart(6, "0");
}

function now7() {
  const d = new Date();
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${d.toISOString().slice(11, 19).replace(/:/g, "")}`;
}

/** Built-in ATM simulator: behaves like an NDC/DDC ATM talking to the switch (PIN encrypted at the "EPP"). */
export class AtmSimulator {
  constructor(private terminalId: string, private sw: SwitchAdapter, private acquirerId = "NEOBANK") {}

  private base(cardToken: string, pin: string, pc: string, amount: bigint, currency: string): IsoMessage {
    return {
      mti: "0200",
      fields: {
        [DE.PAN_TOKEN]: cardToken, [DE.PROCESSING_CODE]: pc, [DE.AMOUNT]: amountField(amount), [DE.TRANSMISSION_TIME]: now7(), [DE.STAN]: nextStan(),
        [DE.ENTRY_MODE]: "051", [DE.ACQUIRER_ID]: this.acquirerId, [DE.TERMINAL_ID]: this.terminalId, [DE.CURRENCY]: CURRENCY_NUMERIC[currency] ?? "818",
        [DE.PIN_BLOCK]: getHsm().encryptPinBlock(pin, cardToken), [DE.MCC]: "6011",
      },
    };
  }
  withdraw(cardToken: string, pin: string, amount: bigint, currency = "EGP") { return this.sw.send(this.base(cardToken, pin, "011000", amount, currency)); }
  balance(cardToken: string, pin: string, currency = "EGP") { return this.sw.send(this.base(cardToken, pin, "311000", 0n, currency)); }
  miniStatement(cardToken: string, pin: string, currency = "EGP") { return this.sw.send(this.base(cardToken, pin, "381000", 0n, currency)); }
  /** Device reports a dispense fault after approval → reversal advice. */
  dispenseFault(original: IsoMessage) {
    return this.sw.send({ mti: "0420", fields: { ...original.fields, [DE.ORIGINAL_DATA]: original.fields[DE.STAN], [DE.STAN]: nextStan() } });
  }
}

/** POS / e-commerce / contactless simulator (acquirer side). */
export class PosSimulator {
  constructor(private sw: SwitchAdapter, private merchant: { id: string; name: string; mcc: string; city?: string; country?: string; terminalId?: string }, private acquirerId = "NEOBANK") {}
  purchase(opts: { cardToken: string; amount: bigint; currency?: string; mode: "CHIP" | "CONTACTLESS" | "ECOM"; pin?: string; threeDs?: { challengeId: string; code: string }; stan?: string }) {
    const em = opts.mode === "CHIP" ? "051" : opts.mode === "CONTACTLESS" ? "071" : "812";
    const f: Record<string, string> = {
      [DE.PAN_TOKEN]: opts.cardToken, [DE.PROCESSING_CODE]: "000000", [DE.AMOUNT]: amountField(opts.amount), [DE.TRANSMISSION_TIME]: now7(), [DE.STAN]: opts.stan ?? nextStan(),
      [DE.MCC]: this.merchant.mcc, [DE.ENTRY_MODE]: em, [DE.ACQUIRER_ID]: this.acquirerId, [DE.MERCHANT_ID]: this.merchant.id, [DE.CURRENCY]: CURRENCY_NUMERIC[opts.currency ?? "EGP"],
      [DE.MERCHANT_NAME_LOC]: merchantField(this.merchant.name, this.merchant.city, this.merchant.country),
    };
    if (this.merchant.terminalId) f[DE.TERMINAL_ID] = this.merchant.terminalId;
    if (opts.pin) f[DE.PIN_BLOCK] = getHsm().encryptPinBlock(opts.pin, opts.cardToken);
    if (opts.threeDs) f[DE.ADDITIONAL_DATA] = JSON.stringify({ threeDs: opts.threeDs });
    return this.sw.send({ mti: "0100", fields: f });
  }
  completion(original: IsoMessage, amount: bigint) {
    return this.sw.send({ mti: "0220", fields: { ...original.fields, [DE.AMOUNT]: amountField(amount), [DE.ORIGINAL_DATA]: original.fields[DE.STAN], [DE.STAN]: nextStan() } });
  }
  refund(original: IsoMessage, amount: bigint) {
    return this.sw.send({ mti: "0200", fields: { ...original.fields, [DE.PROCESSING_CODE]: "200000", [DE.AMOUNT]: amountField(amount), [DE.ORIGINAL_DATA]: original.fields[DE.STAN], [DE.STAN]: nextStan() } });
  }
  void(original: IsoMessage) {
    return this.sw.send({ mti: "0420", fields: { ...original.fields, [DE.ORIGINAL_DATA]: original.fields[DE.STAN], [DE.STAN]: nextStan() } });
  }
}
