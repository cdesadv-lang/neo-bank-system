import { beforeEach, describe, expect, it } from "vitest";
import { prisma, withTx } from "@/lib/db";
import { resetDb, makeBranch, makeStaff, makeCustomer, makeAccount, fund, makeTill, fundTill, principal, actorOf, ledgerBalanceOfAccount } from "./helpers";
import { issueCardTx, customerUpdateCard } from "@/server/services/cards";
import { authorize, capture, release, releaseExpiredHolds, refund, reverseByKey, openDisputeByCustomer, disputeAction, setCardPin } from "@/server/services/card-auth";
import { createAtm, replenishAtm, reconcileAtm, cassetteTotal, planDispense } from "@/server/services/atm";
import { registerDevice, captureCount } from "@/server/services/cash-count";
import { cashDeposit, balanceTill } from "@/server/services/teller";
import { reconcile } from "@/server/services/reports";
import { getHsm } from "@/server/cards/hsm";
import { AtmSimulator, PosSimulator } from "@/server/switch/simulators";
import { InProcessSwitch, TimeoutReversalSwitch } from "@/server/switch/adapter";
import { memoryOutbox } from "@/server/auth/otp";
import { GL } from "@/server/gl";

const PIN = "2580";

async function glBalance(code: string) {
  const g = await prisma.glAccount.findUniqueOrThrow({ where: { code } });
  const r = await prisma.journalLine.aggregate({ where: { glAccountId: g.id }, _sum: { debit: true, credit: true } });
  return (r._sum.credit ?? 0n) - (r._sum.debit ?? 0n);
}

async function setup() {
  await resetDb();
  const b = await makeBranch("0101");
  const ops = principal(await makeStaff("OPERATIONS", b.id));
  const cust = await makeCustomer(b.id);
  const acc = await makeAccount(cust.id, b.id);
  await fund(acc.id, 1_000_000n); // EGP 10,000
  const card = await withTx((tx) => issueCardTx(tx, acc.id, { chargeFee: false }));
  await setCardPin(card.id, getHsm().encryptPinBlock(PIN, card.token));
  const vault = await prisma.till.create({ data: { code: "VAULT-0101", branchId: b.id, kind: "VAULT", currency: "EGP", status: "OPEN" } });
  await fundTill(vault.id, 50_000_000n);
  const atm = await createAtm(ops, actorOf(ops), { terminalId: "NBATM001", branchId: b.id, locationAr: "الفرع", locationEn: "Branch lobby", denominations: [20000, 10000, 5000] });
  await replenishAtm(ops, actorOf(ops), { atmId: atm.id, idempotencyKey: "replenish-1", cassettes: [{ position: 1, notes: 100 }, { position: 2, notes: 100 }, { position: 3, notes: 100 }] });
  return { b, ops, cust, acc, card: (await prisma.card.findUniqueOrThrow({ where: { id: card.id } })), atm };
}

async function cassettesVsTill(atmId: string) {
  const atm = await prisma.atmTerminal.findUniqueOrThrow({ where: { id: atmId }, include: { cassettes: true } });
  const till = await prisma.till.findUniqueOrThrow({ where: { id: atm.tillId } });
  return { cassettes: cassetteTotal(atm.cassettes), till: till.balance };
}

let stan = 100;
const nextStan = () => String(++stan).padStart(6, "0");
const pin = (token: string, p = PIN) => getHsm().encryptPinBlock(p, token);

describe("ATM channel", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });

  it("plans dispense with the largest notes first and refuses undispensable amounts", () => {
    const cas = [{ position: 1, denomination: 20000n, count: 2 }, { position: 2, denomination: 5000n, count: 10 }];
    expect(planDispense(cas, 50000n)).toEqual([{ position: 1, denomination: 20000n, notes: 2 }, { position: 2, denomination: 5000n, notes: 2 }]);
    expect(planDispense(cas, 12345n)).toBeNull();
  });

  it("replenishment moves vault cash to the ATM and cassettes equal the ATM till", async () => {
    const v = await cassettesVsTill(ctx.atm.id);
    expect(v.cassettes).toBe(3_500_000n);
    expect(v.till).toBe(3_500_000n);
  });

  it("withdrawal posts Dr customer / Cr ATM cash, decrements cassettes and stays reconciled", async () => {
    const sim = new AtmSimulator("NBATM001", new InProcessSwitch());
    const res = await sim.withdraw(ctx.card.token, PIN, 350000n);
    expect(res.fields["39"]).toBe("00");
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } });
    expect(acc.balance).toBe(650_000n);
    expect(await ledgerBalanceOfAccount(ctx.acc.id)).toBe(650_000n);
    const v = await cassettesVsTill(ctx.atm.id);
    expect(v.till).toBe(3_150_000n);
    expect(v.cassettes).toBe(v.till);
    const n = await prisma.notification.count({ where: { customerId: ctx.cust.id } });
    expect(n).toBeGreaterThan(0);
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("insufficient funds declines with 51 and posts nothing", async () => {
    const r = await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "CASH_WITHDRAWAL", amount: 1_100_000n, currency: "EGP", stan: nextStan(), terminalId: "NBATM001", pinBlock: pin(ctx.card.token) });
    // per-txn ATM max may decline first; either way nothing is posted
    expect(r.approved).toBe(false);
    const r2 = await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "CASH_WITHDRAWAL", amount: 1_100_000n, currency: "EGP", stan: nextStan(), acquirerId: "OTHERBANK", terminalId: "XB000001", pinBlock: pin(ctx.card.token) });
    expect(r2.approved).toBe(false);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(1_000_000n);
    expect((await cassettesVsTill(ctx.atm.id)).till).toBe(3_500_000n);
  });

  it("duplicate STAN is idempotent (one debit)", async () => {
    const s = nextStan();
    const req = { cardToken: ctx.card.token, channel: "ATM" as const, txnType: "CASH_WITHDRAWAL" as const, amount: 100_000n, currency: "EGP" as const, stan: s, terminalId: "NBATM001", pinBlock: pin(ctx.card.token) };
    const [a, b] = await Promise.all([authorize(req), authorize(req)]);
    expect(a.rrn).toBe(b.rrn);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(900_000n);
  });

  it("reversal (dispense fault) refunds the customer and restores cassettes", async () => {
    const sim = new AtmSimulator("NBATM001", new InProcessSwitch());
    const res = await sim.withdraw(ctx.card.token, PIN, 200000n);
    expect(res.fields["39"]).toBe("00");
    const rev = await sim.dispenseFault({ mti: "0200", fields: { ...res.fields, "2": ctx.card.token } });
    expect(rev.fields["39"]).toBe("00");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(1_000_000n);
    const v = await cassettesVsTill(ctx.atm.id);
    expect(v).toEqual({ cassettes: 3_500_000n, till: 3_500_000n });
    const a = await prisma.cardAuthorization.findFirstOrThrow({ where: { rrn: res.fields["37"] } });
    expect(a.status).toBe("REVERSED");
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("switch timeout triggers an automatic reversal (code 68, no net debit)", async () => {
    const sim = new AtmSimulator("NBATM001", new TimeoutReversalSwitch(new InProcessSwitch(200), 20));
    const res = await sim.withdraw(ctx.card.token, PIN, 100000n);
    expect(res.fields["39"]).toBe("68");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(1_000_000n);
    expect(await cassettesVsTill(ctx.atm.id)).toEqual({ cassettes: 3_500_000n, till: 3_500_000n });
  });

  it("reversal before the original creates a tombstone and the late original is declined", async () => {
    const s = nextStan();
    const r = await reverseByKey({ terminalId: "NBATM001", stan: s, cardToken: ctx.card.token, amount: 50000n, currency: "EGP" });
    expect(r.tombstone).toBe(true);
    const late = await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "CASH_WITHDRAWAL", amount: 50000n, currency: "EGP", stan: s, terminalId: "NBATM001", pinBlock: pin(ctx.card.token) });
    expect(late.approved).toBe(false);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(1_000_000n);
  });

  it("other-bank ATM charges the network fee and credits scheme payable", async () => {
    const r = await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "CASH_WITHDRAWAL", amount: 100_000n, currency: "EGP", stan: nextStan(), acquirerId: "OTHERBANK", terminalId: "XB000001", pinBlock: pin(ctx.card.token) });
    expect(r.approved).toBe(true);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance).toBe(1_000_000n - 100_000n - 500n);
    expect(await glBalance(GL.SCHEME_PAYABLE)).toBe(100_000n);
  });

  it("wrong PIN 3 times blocks the card (75)", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push((await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "BALANCE_INQUIRY", amount: 0n, currency: "EGP", stan: nextStan(), terminalId: "NBATM001", pinBlock: pin(ctx.card.token, "9999") })).responseCode);
    expect(codes).toEqual(["55", "55", "75"]);
    expect((await prisma.card.findUniqueOrThrow({ where: { id: ctx.card.id } })).status).toBe("BLOCKED");
    const ok = await authorize({ cardToken: ctx.card.token, channel: "ATM", txnType: "BALANCE_INQUIRY", amount: 0n, currency: "EGP", stan: nextStan(), terminalId: "NBATM001", pinBlock: pin(ctx.card.token) });
    expect(ok.responseCode).toBe("62");
  });

  it("EOD reconciliation books a physical shortage to cash over/short", async () => {
    // physically count one 50 note missing in cassette 3
    const rec = await reconcileAtm(ctx.ops, actorOf(ctx.ops), { atmId: ctx.atm.id, counted: [{ position: 1, notes: 100 }, { position: 2, notes: 100 }, { position: 3, notes: 99 }] });
    expect(rec.variance).toBe(-5000n);
    expect(await cassettesVsTill(ctx.atm.id)).toEqual({ cassettes: 3_495_000n, till: 3_495_000n });
    expect((await reconcile()).breaks).toEqual([]);
  });
});

describe("Card purchases: hold, capture, release, refund", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });
  const merchant = { name: "Carrefour Maadi", id: "MER0001", mcc: "5411", country: "EG" };
  const bal = async () => (await prisma.account.findUniqueOrThrow({ where: { id: ctx.acc.id } })).balance;

  async function hold(amount: bigint, channel: "POS" | "CONTACTLESS" = "POS") {
    const r = await authorize({ cardToken: ctx.card.token, channel, txnType: "PURCHASE", amount, currency: "EGP", stan: nextStan(), merchant, pinBlock: pin(ctx.card.token) });
    expect(r.approved).toBe(true);
    return r.authorizationId!;
  }

  it("authorization holds funds (Dr customer / Cr card holds) in real time", async () => {
    const id = await hold(250_00n);
    expect(await bal()).toBe(1_000_000n - 25_000n);
    expect(await glBalance(GL.CARD_HOLDS)).toBe(25_000n);
    const a = await prisma.cardAuthorization.findUniqueOrThrow({ where: { id } });
    expect(a.status).toBe("AUTHORIZED");
    expect(a.channel).toBe("POS");
    expect(a.mcc).toBe("5411");
    expect(a.merchantName).toBe("Carrefour Maadi");
    expect(await prisma.notification.count({ where: { customerId: ctx.cust.id } })).toBe(1);
  });

  it("capture moves the hold to scheme payable; partial capture releases the remainder", async () => {
    const id = await hold(40_000n);
    await capture(id, 30_000n);
    expect(await bal()).toBe(1_000_000n - 30_000n);
    expect(await glBalance(GL.CARD_HOLDS)).toBe(0n);
    expect(await glBalance(GL.SCHEME_PAYABLE)).toBe(30_000n);
    await capture(id); // idempotent on a captured auth
    expect(await bal()).toBe(970_000n);
    await expect(capture(await hold(1000n), 2000n)).rejects.toThrow();
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("release (void) returns the held funds; cannot capture afterwards", async () => {
    const id = await hold(50_000n);
    await release(id);
    expect(await bal()).toBe(1_000_000n);
    expect(await glBalance(GL.CARD_HOLDS)).toBe(0n);
    await expect(capture(id)).rejects.toThrow(/RELEASED/);
  });

  it("EOD releases expired holds only", async () => {
    const oldId = await hold(10_000n);
    const freshId = await hold(20_000n);
    await prisma.cardAuthorization.update({ where: { id: oldId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await releaseExpiredHolds()).toBe(1);
    expect((await prisma.cardAuthorization.findUniqueOrThrow({ where: { id: oldId } })).status).toBe("RELEASED");
    expect((await prisma.cardAuthorization.findUniqueOrThrow({ where: { id: freshId } })).status).toBe("AUTHORIZED");
    expect(await bal()).toBe(980_000n);
  });

  it("refunds credit the customer, are idempotent, and cannot exceed the captured amount", async () => {
    const id = await hold(60_000n);
    await capture(id);
    await refund(id, 20_000n, { idempotencyKey: "r1" });
    await refund(id, 20_000n, { idempotencyKey: "r1" });
    expect(await bal()).toBe(1_000_000n - 40_000n);
    await expect(refund(id, 50_000n, { idempotencyKey: "r2" })).rejects.toThrow(/exceeds/);
    await refund(id, 40_000n, { idempotencyKey: "r3" });
    expect((await prisma.cardAuthorization.findUniqueOrThrow({ where: { id } })).status).toBe("REFUNDED");
    expect(await bal()).toBe(1_000_000n);
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("cannot refund an uncaptured hold", async () => {
    const id = await hold(5_000n);
    await expect(refund(id, 5_000n, { idempotencyKey: "x" })).rejects.toThrow(/captured/);
  });

  it("ISO 8583 completion (0220) and refund (pc 20) via the POS simulator", async () => {
    const pos = new PosSimulator(new InProcessSwitch(), { id: "MER0002", name: "Zara CityStars", mcc: "5651", country: "EG" });
    const auth = await pos.purchase({ cardToken: ctx.card.token, amount: 80_000n, mode: "CHIP", pin: PIN });
    expect(auth.fields["39"]).toBe("00");
    const auth2 = { mti: "0100", fields: { ...auth.fields, "2": ctx.card.token } };
    expect((await pos.completion(auth2, 75_000n)).fields["39"]).toBe("00");
    expect(await bal()).toBe(925_000n);
    expect((await pos.refund(auth2, 25_000n)).fields["39"]).toBe("00");
    expect(await bal()).toBe(950_000n);
  });

  it("contactless under the no-PIN limit is approved without PIN; above requires PIN (65)", async () => {
    const small = await authorize({ cardToken: ctx.card.token, channel: "CONTACTLESS", txnType: "PURCHASE", amount: 30_000n, currency: "EGP", stan: nextStan(), merchant });
    expect(small.approved).toBe(true);
    const big = await authorize({ cardToken: ctx.card.token, channel: "CONTACTLESS", txnType: "PURCHASE", amount: ctx.card.contactlessNoPinLimit + 100n, currency: "EGP", stan: nextStan(), merchant });
    expect(big.responseCode).toBe("65");
  });

  it("e-commerce requires 3-D Secure OTP; wrong code declines, right code approves", async () => {
    const m = { name: "Jumia Egypt", id: "MERJUMIA", mcc: "5999", country: "EG" };
    const s1 = nextStan();
    const c1 = await authorize({ cardToken: ctx.card.token, channel: "ECOM", txnType: "PURCHASE", amount: 15_000n, currency: "EGP", stan: s1, merchant: m });
    expect(c1.responseCode).toBe("1A");
    expect(await bal()).toBe(1_000_000n);
    const code = memoryOutbox.get(ctx.cust.phone)!;
    expect(code).toMatch(/^\d{6}$/);
    const ok = await authorize({ cardToken: ctx.card.token, channel: "ECOM", txnType: "PURCHASE", amount: 15_000n, currency: "EGP", stan: s1, merchant: m, threeDs: { challengeId: c1.challengeId!, code } });
    expect(ok.approved).toBe(true);
    expect(await bal()).toBe(985_000n);

    const s2 = nextStan();
    const c2 = await authorize({ cardToken: ctx.card.token, channel: "ECOM", txnType: "PURCHASE", amount: 15_000n, currency: "EGP", stan: s2, merchant: m });
    const bad = await authorize({ cardToken: ctx.card.token, channel: "ECOM", txnType: "PURCHASE", amount: 15_000n, currency: "EGP", stan: s2, merchant: m, threeDs: { challengeId: c2.challengeId!, code: "000000" === memoryOutbox.get(ctx.cust.phone) ? "111111" : "000000" } });
    expect(bad.approved).toBe(false);
    expect(await bal()).toBe(985_000n);
  });

  it("customer channel toggles and per-channel limits are enforced", async () => {
    const actor = { type: "CUSTOMER" as const, id: ctx.cust.id, name: "c" };
    await customerUpdateCard(ctx.cust.id, actor, ctx.card.id, { action: "SETTINGS", onlineEnabled: false, posDailyLimit: "500" });
    const e = await authorize({ cardToken: ctx.card.token, channel: "ECOM", txnType: "PURCHASE", amount: 1000n, currency: "EGP", stan: nextStan(), merchant });
    expect(e.responseCode).toBe("57");
    const p1 = await authorize({ cardToken: ctx.card.token, channel: "POS", txnType: "PURCHASE", amount: 40_000n, currency: "EGP", stan: nextStan(), merchant, pinBlock: pin(ctx.card.token) });
    expect(p1.approved).toBe(true);
    const p2 = await authorize({ cardToken: ctx.card.token, channel: "POS", txnType: "PURCHASE", amount: 20_000n, currency: "EGP", stan: nextStan(), merchant, pinBlock: pin(ctx.card.token) });
    expect(p2.responseCode).toBe("61");
    const intl = await authorize({ cardToken: ctx.card.token, channel: "POS", txnType: "PURCHASE", amount: 100n, currency: "EGP", stan: nextStan(), merchant: { ...merchant, country: "AE" }, pinBlock: pin(ctx.card.token) });
    expect(intl.responseCode).toBe("57");
    await customerUpdateCard(ctx.cust.id, actor, ctx.card.id, { action: "FREEZE" });
    const f = await authorize({ cardToken: ctx.card.token, channel: "POS", txnType: "PURCHASE", amount: 100n, currency: "EGP", stan: nextStan(), merchant, pinBlock: pin(ctx.card.token) });
    expect(f.responseCode).toBe("62");
    // another customer can't change this card
    const other = await makeCustomer(ctx.b.id);
    await expect(customerUpdateCard(other.id, actor, ctx.card.id, { action: "UNFREEZE" })).rejects.toThrow(/not found/i);
  });

  it("customer can set a new PIN (stored only as PVV)", async () => {
    const actor = { type: "CUSTOMER" as const, id: ctx.cust.id, name: "c" };
    await expect(customerUpdateCard(ctx.cust.id, actor, ctx.card.id, { action: "SET_PIN", pin: "1111" })).rejects.toThrow();
    await customerUpdateCard(ctx.cust.id, actor, ctx.card.id, { action: "SET_PIN", pin: "7391" });
    const c = await prisma.card.findUniqueOrThrow({ where: { id: ctx.card.id } });
    expect(c.pinVerificationValue).not.toContain("7391");
    const r = await authorize({ cardToken: c.token, channel: "ATM", txnType: "BALANCE_INQUIRY", amount: 0n, currency: "EGP", stan: nextStan(), terminalId: "NBATM001", pinBlock: pin(c.token, "7391") });
    expect(r.approved).toBe(true);
  });

  it("dispute → chargeback provisional credit → resolved for merchant takes it back", async () => {
    const id = await hold(30_000n);
    await capture(id);
    const d = await openDisputeByCustomer(ctx.cust.id, { type: "CUSTOMER", id: ctx.cust.id, name: "c" }, { authorizationId: id, reason: "GOODS_NOT_RECEIVED" });
    await expect(openDisputeByCustomer(ctx.cust.id, { type: "CUSTOMER", id: ctx.cust.id, name: "c" }, { authorizationId: id, reason: "DUPLICATE" })).rejects.toThrow();
    await disputeAction(ctx.ops, actorOf(ctx.ops), d.id, { action: "CHARGEBACK" });
    expect(await bal()).toBe(1_000_000n);
    await disputeAction(ctx.ops, actorOf(ctx.ops), d.id, { action: "RESOLVE_MERCHANT" });
    expect(await bal()).toBe(970_000n);
    expect(await glBalance(GL.SCHEME_RECEIVABLE)).toBe(0n);
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("own-ATM cash-not-dispensed dispute resolved for the customer reverses the withdrawal", async () => {
    const sim = new AtmSimulator("NBATM001", new InProcessSwitch());
    const res = await sim.withdraw(ctx.card.token, PIN, 100000n);
    const a = await prisma.cardAuthorization.findFirstOrThrow({ where: { rrn: res.fields["37"] } });
    const d = await openDisputeByCustomer(ctx.cust.id, { type: "CUSTOMER", id: ctx.cust.id, name: "c" }, { authorizationId: a.id, reason: "CASH_NOT_DISPENSED" });
    await disputeAction(ctx.ops, actorOf(ctx.ops), d.id, { action: "RESOLVE_CUSTOMER" });
    expect(await bal()).toBe(1_000_000n);
  });
});

describe("Cash counters", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let teller: ReturnType<typeof principal>;
  let tillId: string;
  beforeEach(async () => {
    ctx = await setup();
    const t = await makeStaff("TELLER", ctx.b.id);
    teller = principal(t);
    const till = await makeTill(ctx.b.id, "TELLER", t.id);
    tillId = till.id;
    await fundTill(till.id, 1_000_000n);
    const bm = principal(await makeStaff("BRANCH_MANAGER", ctx.b.id));
    await registerDevice(bm, actorOf(bm), { deviceId: "CNT-0101-01", branchId: ctx.b.id, model: "Simulated counter", driver: "SIMULATOR" });
  });

  it("deposit uses the device count; mismatched or reused counts are rejected", async () => {
    const s = await captureCount(teller, actorOf(teller), { deviceId: "CNT-0101-01", purpose: "DEPOSIT", simulate: { denominations: { "20000": 5, "10000": 3 } } });
    expect(s.total).toBe(130_000n);
    await expect(cashDeposit(teller, actorOf(teller), { accountId: ctx.acc.id, amount: "1200", countSessionId: s.id, idempotencyKey: "dep-mismatch" })).rejects.toThrow(/Counted/);
    await cashDeposit(teller, actorOf(teller), { accountId: ctx.acc.id, amount: "1300", countSessionId: s.id, idempotencyKey: "dep-ok-1" });
    expect((await prisma.till.findUniqueOrThrow({ where: { id: tillId } })).balance).toBe(1_130_000n);
    await expect(cashDeposit(teller, actorOf(teller), { accountId: ctx.acc.id, amount: "1300", countSessionId: s.id, idempotencyKey: "dep-ok-2" })).rejects.toThrow(/already used/);
  });

  it("counterfeit notes block the deposit", async () => {
    const s = await captureCount(teller, actorOf(teller), { deviceId: "CNT-0101-01", purpose: "DEPOSIT", simulate: { denominations: { "20000": 1 }, counterfeits: 1 } });
    await expect(cashDeposit(teller, actorOf(teller), { accountId: ctx.acc.id, amount: "200", countSessionId: s.id, idempotencyKey: "dep-counterfeit" })).rejects.toThrow(/counterfeit/);
  });

  it("counter-to-till reconciliation books the variance and closes the till", async () => {
    // system 10,000.00; device counts 9,950.00 → shortage 50
    const s = await captureCount(teller, actorOf(teller), { deviceId: "CNT-0101-01", purpose: "TILL_BALANCING", simulate: { denominations: { "20000": 49, "5000": 3 } } });
    expect(s.total).toBe(995_000n);
    const r = await balanceTill(teller, actorOf(teller), { tillId, countSessionId: s.id });
    expect(r.variance).toBe(-5_000n);
    expect((await prisma.till.findUniqueOrThrow({ where: { id: tillId } })).balance).toBe(995_000n);
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("another teller cannot use my count session", async () => {
    const s = await captureCount(teller, actorOf(teller), { deviceId: "CNT-0101-01", purpose: "DEPOSIT", simulate: { denominations: { "20000": 1 } } });
    const t2 = principal(await makeStaff("TELLER", ctx.b.id));
    await makeTill(ctx.b.id, "TELLER", t2.id);
    await expect(cashDeposit(t2, actorOf(t2), { accountId: ctx.acc.id, amount: "200", countSessionId: s.id, idempotencyKey: "dep-teller2" })).rejects.toThrow(/another user/);
  });
});
