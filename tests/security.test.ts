import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetDb, makeBranch, makeStaff, makeCustomer, makeAccount, fund, makeTill, fundTill, principal, actorOf } from "./helpers";
import { can, ROLE_PERMISSIONS, PERMISSIONS } from "@/server/rbac";
import { listCustomers, getCustomer } from "@/server/services/customers";
import { getAccount, requestStatusChange } from "@/server/services/accounts";
import { cashDeposit, cashWithdrawal } from "@/server/services/teller";
import { requestManualJournal } from "@/server/services/journals";
import { decideApproval } from "@/server/services/approvals";
import { myAccount, myStatement, startTransfer } from "@/server/services/portal";
import { staffLogin, customerLoginStart, customerLoginVerify } from "@/server/auth/login";
import { createStaffSession, createCustomerSession, getCustomerByToken } from "@/server/auth/session";
import { checkPasswordPolicy, hashPassword } from "@/server/auth/password";
import { generateTotpSecret, totp } from "@/server/auth/totp";
import { memoryOutbox } from "@/server/auth/otp";
import { runEod } from "@/server/services/eod";
import { reconcile } from "@/server/services/reports";
import { todayStr } from "@/lib/dates";
import { GET as customersGET } from "@/app/api/staff/customers/route";
import { GET as portalAccountGET } from "@/app/api/portal/accounts/[id]/route";
import { POST as journalPOST } from "@/app/api/staff/journals/manual/route";

let cairo: Awaited<ReturnType<typeof makeBranch>>, alex: Awaited<ReturnType<typeof makeBranch>>;
beforeEach(async () => {
  await resetDb();
  cairo = await makeBranch("0101");
  alex = await makeBranch("0201");
});

const NOP = { params: Promise.resolve({}) };

describe("RBAC", () => {
  it("every role has a defined permission set and only SUPER_ADMIN has all permissions", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(perms.length, role).toBeGreaterThan(0);
      if (role !== "SUPER_ADMIN") expect(perms.length, role).toBeLessThan(PERMISSIONS.length);
    }
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(10);
  });

  it("denies teller manual journals, auditor writes, CS cash operations", async () => {
    const teller = principal(await makeStaff("TELLER", cairo.id));
    const auditor = principal(await makeStaff("AUDITOR", null));
    const cs = principal(await makeStaff("CUSTOMER_SERVICE", cairo.id));
    expect(can(teller, "journal.manual")).toBe(false);
    expect(can(auditor, "cash.deposit")).toBe(false);
    expect(can(auditor, "customer.read")).toBe(true);
    await expect(requestManualJournal(teller, actorOf(teller), {})).rejects.toThrow(/lacks permission/);
    const c = await makeCustomer(cairo.id);
    const a = await makeAccount(c.id, cairo.id);
    await expect(cashDeposit(cs, actorOf(cs), { accountId: a.id, amount: "100", idempotencyKey: "cs-deposit-1" })).rejects.toThrow(/lacks permission/);
    await expect(cashDeposit(auditor, actorOf(auditor), { accountId: a.id, amount: "100", idempotencyKey: "au-deposit-1" })).rejects.toThrow(/lacks permission/);
  });

  it("route handlers enforce authentication and permissions with real session cookies", async () => {
    const unauth = await customersGET(new Request("http://localhost:3100/api/staff/customers"), NOP);
    expect(unauth.status).toBe(401);
    const teller = await makeStaff("TELLER", cairo.id);
    const { token } = await createStaffSession(teller.id);
    const ok = await customersGET(new Request("http://localhost:3100/api/staff/customers", { headers: { cookie: `nb_staff=${token}` } }), NOP);
    expect(ok.status).toBe(200);
    const denied = await journalPOST(new Request("http://localhost:3100/api/staff/journals/manual", { method: "POST", headers: { cookie: `nb_staff=${token}`, "content-type": "application/json" }, body: "{}" }), NOP);
    expect(denied.status).toBe(403);
    // CSRF: cross-origin write rejected
    const fin = await makeStaff("FINANCE", null);
    const s2 = await createStaffSession(fin.id);
    const csrf = await journalPOST(new Request("http://localhost:3100/api/staff/journals/manual", { method: "POST", headers: { cookie: `nb_staff=${s2.token}`, origin: "https://evil.example", host: "localhost:3100" }, body: "{}" }), NOP);
    expect(csrf.status).toBe(403);
    expect((await csrf.json()).error.code).toBe("CSRF_REJECTED");
  });
});

describe("Branch scoping", () => {
  it("branch staff only see and operate on their own branch", async () => {
    const cCairo = await makeCustomer(cairo.id);
    const cAlex = await makeCustomer(alex.id);
    const aAlex = await makeAccount(cAlex.id, alex.id);
    await fund(aAlex.id, 100_000n);
    const tellerCairo = principal(await makeStaff("TELLER", cairo.id));
    await fundTill((await makeTill(cairo.id, "TELLER", tellerCairo.id)).id, 1_000_000n);
    const list = await listCustomers(tellerCairo, {});
    const ids = list.rows.map((c) => c.id);
    expect(ids).toContain(cCairo.id);
    expect(ids).not.toContain(cAlex.id);
    await expect(getCustomer(tellerCairo, cAlex.id)).rejects.toThrow();
    await expect(getAccount(tellerCairo, aAlex.id)).rejects.toThrow();
    await expect(cashWithdrawal(tellerCairo, actorOf(tellerCairo), { accountId: aAlex.id, amount: "100", idempotencyKey: "cross-branch-1" })).rejects.toThrow();
    expect((await prisma.account.findUniqueOrThrow({ where: { id: aAlex.id } })).balance).toBe(100_000n);
    // head-office roles see all branches
    const auditor = principal(await makeStaff("AUDITOR", null));
    await expect(getCustomer(auditor, cAlex.id)).resolves.toBeTruthy();
  });

  it("a branch manager cannot approve another branch's request", async () => {
    const c = await makeCustomer(alex.id);
    const a = await makeAccount(c.id, alex.id);
    const csAlex = principal(await makeStaff("OPERATIONS", alex.id));
    const req = await requestStatusChange(csAlex, actorOf(csAlex), a.id, { status: "FROZEN", reason: "Court order 123" });
    const bmCairo = principal(await makeStaff("BRANCH_MANAGER", cairo.id));
    await expect(decideApproval(bmCairo, actorOf(bmCairo), (req as { id: string }).id, "APPROVE")).rejects.toThrow(/another branch/);
  });
});

describe("Customer isolation (portal)", () => {
  it("a customer cannot read or move money from another customer's account", async () => {
    const c1 = await makeCustomer(cairo.id);
    const c2 = await makeCustomer(cairo.id);
    const a1 = await makeAccount(c1.id, cairo.id);
    const a2 = await makeAccount(c2.id, cairo.id);
    await fund(a2.id, 500_000n);
    await expect(myAccount(c1.id, a2.id)).rejects.toThrow(/not found/i);
    await expect(myStatement(c1.id, a2.id)).rejects.toThrow(/not found/i);
    const p1 = { userId: "u1", customerId: c1.id, cif: c1.cif, nameAr: "", nameEn: "", phone: c1.phone, branchId: cairo.id, kycStatus: "APPROVED" };
    await expect(startTransfer(p1, { fromAccountId: a2.id, toAccountNumber: a1.accountNumber, amount: "100", idempotencyKey: "steal-attempt-1" })).rejects.toThrow(/not found/i);

    // through the HTTP handler with a real portal session
    const user = await prisma.customerUser.create({ data: { customerId: c1.id, username: "c1user", passwordHash: await hashPassword("Cust0mer!Pass") } });
    const { token } = await createCustomerSession(user.id);
    const res = await portalAccountGET(new Request(`http://localhost:3100/api/portal/accounts/${a2.id}`, { headers: { cookie: `nb_portal=${token}` } }), { params: Promise.resolve({ id: a2.id }) });
    expect(res.status).toBe(404);
    const own = await portalAccountGET(new Request(`http://localhost:3100/api/portal/accounts/${a1.id}`, { headers: { cookie: `nb_portal=${token}` } }), { params: Promise.resolve({ id: a1.id }) });
    expect(own.status).toBe(200);
  });
});

describe("Maker-checker", () => {
  async function manualJournal(maker: ReturnType<typeof principal>) {
    const gls = await prisma.glAccount.findMany({ where: { allowManualPosting: true, isControl: false, type: { in: ["EXPENSE", "ASSET"] } } });
    const exp = gls.find((g) => g.type === "EXPENSE")!;
    const asset = gls.find((g) => g.type === "ASSET")!;
    return requestManualJournal(maker, actorOf(maker), { currency: "EGP", description: "Office rent accrual", lines: [{ glCode: exp.code, debit: "1000" }, { glCode: asset.code, credit: "1000" }] });
  }

  it("maker cannot approve own request; wrong role cannot approve; correct checker executes once", async () => {
    const maker = principal(await makeStaff("FINANCE", null));
    const req = (await manualJournal(maker)) as { id: string };
    const before = await prisma.journalEntry.count();
    await expect(decideApproval(maker, actorOf(maker), req.id, "APPROVE")).rejects.toThrow(/own request/);
    const bm = principal(await makeStaff("BRANCH_MANAGER", null));
    await expect(decideApproval(bm, actorOf(bm), req.id, "APPROVE")).rejects.toThrow(/cannot check/);
    const teller = principal(await makeStaff("TELLER", cairo.id));
    await expect(decideApproval(teller, actorOf(teller), req.id, "APPROVE")).rejects.toThrow(/lacks permission/);
    expect(await prisma.journalEntry.count()).toBe(before);
    const checker = principal(await makeStaff("FINANCE", null));
    const done = await decideApproval(checker, actorOf(checker), req.id, "APPROVE");
    expect(done.status).toBe("APPROVED");
    expect(await prisma.journalEntry.count()).toBe(before + 1);
    await expect(decideApproval(checker, actorOf(checker), req.id, "APPROVE")).rejects.toThrow(/already decided/);
    expect((await reconcile()).breaks).toEqual([]);
  });

  it("large cash withdrawal (≥ EGP 250k) waits for a branch manager", async () => {
    const c = await makeCustomer(cairo.id);
    const a = await makeAccount(c.id, cairo.id);
    await fund(a.id, 40_000_000n);
    const t = await makeStaff("TELLER", cairo.id);
    const teller = principal(t);
    await fundTill((await makeTill(cairo.id, "TELLER", t.id)).id, 50_000_000n);
    const r = (await cashWithdrawal(teller, actorOf(teller), { accountId: a.id, amount: "300000", idempotencyKey: "large-cash-1" })) as { pendingApproval: boolean; approvalId: string };
    expect(r.pendingApproval).toBe(true);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).balance).toBe(40_000_000n);
    const bm = principal(await makeStaff("BRANCH_MANAGER", cairo.id));
    await decideApproval(bm, actorOf(bm), r.approvalId, "APPROVE");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).balance).toBeLessThanOrEqual(10_000_000n);
  });

  it("concurrent checkers cannot both execute", async () => {
    const maker = principal(await makeStaff("FINANCE", null));
    const req = (await manualJournal(maker)) as { id: string };
    const c1 = principal(await makeStaff("FINANCE", null));
    const c2 = principal(await makeStaff("SUPER_ADMIN", null));
    const before = await prisma.journalEntry.count();
    const res = await Promise.allSettled([decideApproval(c1, actorOf(c1), req.id, "APPROVE"), decideApproval(c2, actorOf(c2), req.id, "APPROVE")]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.journalEntry.count()).toBe(before + 1);
  });
});

describe("Authentication", () => {
  it("password policy", () => {
    expect(checkPasswordPolicy("short")).not.toBeNull();
    expect(checkPasswordPolicy("alllowercaseletters")).not.toBeNull();
    expect(checkPasswordPolicy("G00d!Passw0rd")).toBeNull();
  });

  it("staff lockout after 5 failures even with the right password afterwards", async () => {
    const s = await makeStaff("TELLER", cairo.id, "lockme");
    for (let i = 0; i < 5; i++) await expect(staffLogin({ username: "lockme", password: "wrong" }, `10.0.0.${i}`)).rejects.toThrow(/Invalid/);
    await expect(staffLogin({ username: "lockme", password: "Passw0rd!Test" })).rejects.toThrow(/locked/);
    await prisma.staff.update({ where: { id: s.id }, data: { lockedUntil: null } });
    await expect(staffLogin({ username: "lockme", password: "Passw0rd!Test" })).resolves.toHaveProperty("token");
  });

  it("TOTP is required when enabled", async () => {
    const secret = generateTotpSecret();
    const s = await makeStaff("FINANCE", null, "totpuser");
    await prisma.staff.update({ where: { id: s.id }, data: { totpEnabled: true, totpSecret: secret } });
    await expect(staffLogin({ username: "totpuser", password: "Passw0rd!Test" })).rejects.toThrow(/Two-factor/);
    await expect(staffLogin({ username: "totpuser", password: "Passw0rd!Test", totp: "000000" === totp(secret) ? "111111" : "000000" })).rejects.toThrow(/Invalid two-factor/);
    await expect(staffLogin({ username: "totpuser", password: "Passw0rd!Test", totp: totp(secret) })).resolves.toHaveProperty("token");
  });

  it("customer login requires password + SMS OTP; OTP is single-use", async () => {
    const c = await makeCustomer(cairo.id);
    await prisma.customer.update({ where: { id: c.id }, data: { status: "ACTIVE" } });
    await prisma.customerUser.create({ data: { customerId: c.id, username: "otpuser", passwordHash: await hashPassword("Cust0mer!Pass") } });
    await expect(customerLoginStart({ username: "otpuser", password: "bad" })).rejects.toThrow(/Invalid/);
    const ch = await customerLoginStart({ username: "otpuser", password: "Cust0mer!Pass" });
    const code = memoryOutbox.get(c.phone)!;
    await expect(customerLoginVerify({ username: "otpuser", challengeId: ch.challengeId, code: code === "000000" ? "111111" : "000000" })).rejects.toThrow();
    const sess = await customerLoginVerify({ username: "otpuser", challengeId: ch.challengeId, code });
    expect((await getCustomerByToken(sess.token))?.customerId).toBe(c.id);
    await expect(customerLoginVerify({ username: "otpuser", challengeId: ch.challengeId, code })).rejects.toThrow();
  });
});

describe("EOD", () => {
  it("runs once per business date and leaves the books reconciled", async () => {
    const c = await makeCustomer(cairo.id);
    const a = await makeAccount(c.id, cairo.id, { type: "SAVINGS", rateBps: 1000 });
    await fund(a.id, 10_000_000n);
    const d = todayStr();
    const r = await runEod(d);
    expect(r).toBeTruthy();
    await expect(runEod(d)).rejects.toThrow(/already/);
    expect((await reconcile()).breaks).toEqual([]);
  });
});
