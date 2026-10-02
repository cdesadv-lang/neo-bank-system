import Decimal from "decimal.js";
import { addMonths } from "./dates";

export type Installment = { seq: number; dueDate: Date; payment: bigint; principal: bigint; interest: bigint; balance: bigint };

/**
 * Level-payment (annuity) amortization in integer minor units.
 *   r = annualRate / 12,  A = P·r / (1 − (1+r)^−n)
 * Interest each period = round_half_up(balance · r). The last installment absorbs
 * rounding so that Σ principal == P exactly.
 */
export function amortize(principal: bigint, annualRateBps: number, months: number, firstDue: Date): Installment[] {
  if (principal <= 0n || months <= 0) throw new Error("invalid loan terms");
  Decimal.set({ precision: 40 });
  const P = new Decimal(principal.toString());
  const r = new Decimal(annualRateBps).div(10000).div(12);
  const payment = r.isZero()
    ? P.div(months)
    : P.mul(r).div(new Decimal(1).minus(new Decimal(1).plus(r).pow(-months)));
  const A = BigInt(payment.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
  const out: Installment[] = [];
  let bal = principal;
  for (let i = 1; i <= months; i++) {
    const interest = BigInt(new Decimal(bal.toString()).mul(r).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
    let princ = A - interest;
    if (i === months || princ > bal) princ = bal;
    bal -= princ;
    out.push({ seq: i, dueDate: addMonths(firstDue, i - 1), payment: princ + interest, principal: princ, interest, balance: bal });
  }
  return out;
}

/** Simple daily interest (Actual/365) on a balance, unrounded, in minor units. */
export function dailyInterest(balanceMinor: bigint, annualRateBps: number): Decimal {
  return new Decimal(balanceMinor.toString()).mul(annualRateBps).div(10000).div(365);
}
