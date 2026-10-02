import { AppError } from "@/lib/errors";
import { authorize, capture, refund, reverseByKey, OWN_ACQUIRER, type Channel, type TxnType } from "@/server/services/card-auth";
import { prisma } from "@/lib/db";
import { DE, ENTRY_MODES, NUMERIC_CURRENCY, amountField, parseMerchantField, type IsoMessage } from "./iso8583";

/** Pluggable link to an ATM/POS switch or card processor. */
export interface SwitchAdapter {
  name: string;
  send(msg: IsoMessage): Promise<IsoMessage>;
}

function reply(req: IsoMessage, fields: Record<string, string>): IsoMessage {
  const mti = req.mti.slice(0, 2) + String(Number(req.mti[2]) + 1) + req.mti.slice(3);
  const echo: Record<string, string> = {};
  for (const k of [DE.PROCESSING_CODE, DE.AMOUNT, DE.STAN, DE.TERMINAL_ID, DE.ACQUIRER_ID, DE.CURRENCY, DE.MERCHANT_ID]) if (req.fields[k]) echo[k] = req.fields[k];
  return { mti, fields: { ...echo, ...fields } };
}

function channelOf(msg: IsoMessage): Channel {
  const em = ENTRY_MODES[(msg.fields[DE.ENTRY_MODE] ?? "05").slice(0, 2)] ?? "CHIP";
  const pc = (msg.fields[DE.PROCESSING_CODE] ?? "00").slice(0, 2);
  if (pc === "01" || pc === "31" || pc === "38") return "ATM";
  if (em === "ECOM") return "ECOM";
  if (em === "CONTACTLESS") return "CONTACTLESS";
  return "POS";
}

/** Issuer host: translates ISO 8583 messages into core-banking calls. */
export async function handleIso(msg: IsoMessage): Promise<IsoMessage> {
  const f = msg.fields;
  const pc = (f[DE.PROCESSING_CODE] ?? "000000").slice(0, 2);
  const currency = NUMERIC_CURRENCY[f[DE.CURRENCY] ?? "818"];
  if (!currency) return reply(msg, { [DE.RESPONSE_CODE]: "57" });
  const amount = BigInt(f[DE.AMOUNT] ?? "0");
  const acquirerId = f[DE.ACQUIRER_ID] ?? OWN_ACQUIRER;

  if (msg.mti === "0420" || msg.mti === "0400") {
    const r = await reverseByKey({ acquirerId, terminalId: f[DE.TERMINAL_ID], merchantId: f[DE.MERCHANT_ID], stan: f[DE.ORIGINAL_DATA] ?? f[DE.STAN], cardToken: f[DE.PAN_TOKEN], amount, currency, reason: "ISO reversal" });
    return reply(msg, { [DE.RESPONSE_CODE]: r.reversed ? "00" : "25" });
  }
  if (msg.mti === "0220" || pc === "20") {
    const key = `${acquirerId}:${f[DE.TERMINAL_ID] ?? f[DE.MERCHANT_ID] ?? "-"}:${f[DE.ORIGINAL_DATA]}`;
    const orig = await prisma.cardAuthorization.findUnique({ where: { idempotencyKey: key } });
    if (!orig) return reply(msg, { [DE.RESPONSE_CODE]: "25" });
    try {
      if (pc === "20") await refund(orig.id, amount, { idempotencyKey: `iso:${f[DE.STAN]}` });
      else await capture(orig.id, amount);
      return reply(msg, { [DE.RESPONSE_CODE]: "00", [DE.RRN]: orig.rrn });
    } catch (e) {
      return reply(msg, { [DE.RESPONSE_CODE]: e instanceof AppError && e.code === "VALIDATION_ERROR" ? "13" : "12" });
    }
  }
  if (msg.mti !== "0100" && msg.mti !== "0200") return reply(msg, { [DE.RESPONSE_CODE]: "12" });

  const txnType: TxnType = pc === "01" ? "CASH_WITHDRAWAL" : pc === "31" ? "BALANCE_INQUIRY" : pc === "38" ? "MINI_STATEMENT" : "PURCHASE";
  const add = f[DE.ADDITIONAL_DATA] ? (JSON.parse(f[DE.ADDITIONAL_DATA]) as { threeDs?: { challengeId: string; code: string } }) : {};
  const m = parseMerchantField(f[DE.MERCHANT_NAME_LOC]);
  const res = await authorize({
    cardToken: f[DE.PAN_TOKEN] ?? "", channel: channelOf(msg), txnType, amount, currency, stan: f[DE.STAN] ?? "", acquirerId,
    terminalId: f[DE.TERMINAL_ID], merchant: m ? { name: m.name, id: f[DE.MERCHANT_ID], mcc: f[DE.MCC], country: m.country } : undefined,
    pinBlock: f[DE.PIN_BLOCK], threeDs: add.threeDs, entryMode: ENTRY_MODES[(f[DE.ENTRY_MODE] ?? "05").slice(0, 2)],
  });
  const out: Record<string, string> = { [DE.RESPONSE_CODE]: res.responseCode };
  if (res.rrn) out[DE.RRN] = res.rrn;
  if (res.authCode && res.approved) out[DE.AUTH_CODE] = res.authCode;
  if (res.availableBalance !== undefined) out[DE.ADDITIONAL_AMOUNTS] = `1002${f[DE.CURRENCY] ?? "818"}C${amountField(res.availableBalance)}`;
  const extra: Record<string, unknown> = {};
  if (res.miniStatement) extra.miniStatement = res.miniStatement.map((l) => ({ d: l.date.toISOString().slice(0, 10), t: l.description, dr: l.debit.toString(), cr: l.credit.toString() }));
  if (res.challengeId) extra.challengeId = res.challengeId;
  if (res.dispensed) extra.dispensed = res.dispensed.map((p) => ({ pos: p.position, den: p.denomination.toString(), n: p.notes }));
  if (Object.keys(extra).length) out[DE.ADDITIONAL_DATA] = JSON.stringify(extra);
  return reply(msg, out);
}

/** In-process adapter (built-in switch). Optional artificial latency is used to simulate timeouts. */
export class InProcessSwitch implements SwitchAdapter {
  name = "IN_PROCESS_SWITCH";
  constructor(private latencyMs = 0) {}
  async send(msg: IsoMessage) {
    const res = await handleIso(msg);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    return res;
  }
}

/**
 * Acquirer-side timeout handling: if no response arrives within `timeoutMs`, the
 * terminal does not dispense and a 0420 reversal is sent automatically for the STAN.
 * The issuer reversal is idempotent and safe whether or not the original was processed.
 */
export class TimeoutReversalSwitch implements SwitchAdapter {
  name: string;
  constructor(private inner: SwitchAdapter, private timeoutMs = 30_000) {
    this.name = `${inner.name}+TIMEOUT_REVERSAL`;
  }
  async send(msg: IsoMessage): Promise<IsoMessage> {
    let timer: NodeJS.Timeout | undefined;
    const pending = this.inner.send(msg);
    const timeout = new Promise<"TIMEOUT">((r) => { timer = setTimeout(() => r("TIMEOUT"), this.timeoutMs); });
    const first = await Promise.race([pending, timeout]);
    clearTimeout(timer);
    if (first !== "TIMEOUT") return first;
    if (msg.mti === "0100" || msg.mti === "0200") {
      // wait for the late original to settle (so the reversal finds it), then reverse it
      await pending.catch(() => undefined);
      await this.inner.send({ mti: "0420", fields: { ...msg.fields, [DE.ORIGINAL_DATA]: msg.fields[DE.STAN] } });
    }
    return { mti: msg.mti.slice(0, 2) + String(Number(msg.mti[2]) + 1) + msg.mti.slice(3), fields: { ...msg.fields, [DE.RESPONSE_CODE]: "68", [DE.PIN_BLOCK]: "" } };
  }
}

export function defaultSwitch(): SwitchAdapter {
  return new TimeoutReversalSwitch(new InProcessSwitch(), Number(process.env.SWITCH_TIMEOUT_MS ?? 30_000));
}
