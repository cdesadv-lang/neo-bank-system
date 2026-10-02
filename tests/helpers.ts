import { prisma, withTx } from "@/lib/db";
import { ensureReferenceData } from "@/server/bootstrap";
import { makeIban } from "@/lib/iban";
import { postJournal } from "@/server/ledger";
import type { AccountType, Currency, StaffRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await ensureReferenceData(prisma);
}

let n = 0;
export async function makeBranch(code?: string) {
  n++;
  return prisma.branch.create({ data: { code: code ?? String(1000 + n), nameAr: `فرع ${n}`, nameEn: `Branch ${n}`, city: "Cairo" } });
}

export async function makeStaff(role: StaffRole, branchId: string | null, username?: string) {
  n++;
  return prisma.staff.create({
    data: {
      username: username ?? `${role.toLowerCase()}_${n}`,
      email: `${role.toLowerCase()}_${n}@test.local`,
      fullNameAr: `موظف ${n}`,
      fullNameEn: `Staff ${n}`,
      passwordHash: await bcrypt.hash("Passw0rd!Test", 4),
      role,
      branchId,
    },
  });
}

export async function makeCustomer(branchId: string, opts: { kyc?: "APPROVED" | "PENDING"; risk?: "LOW" | "MEDIUM" | "HIGH" } = {}) {
  n++;
  return prisma.customer.create({
    data: {
      cif: `T${String(n).padStart(7, "0")}`,
      type: "INDIVIDUAL",
      nameAr: `عميل ${n}`,
      nameEn: `Customer ${n}`,
      nationalId: `2900101${String(n).padStart(7, "0")}`,
      phone: `+2010${String(n).padStart(8, "0")}`,
      branchId,
      kycStatus: opts.kyc ?? "APPROVED",
      riskRating: opts.risk ?? "LOW",
    },
  });
}

export async function makeAccount(customerId: string, branchId: string, opts: { type?: AccountType; currency?: Currency; status?: "ACTIVE" | "FROZEN" | "PENDING" | "DORMANT" | "CLOSED"; rateBps?: number } = {}) {
  n++;
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
  const type = opts.type ?? "CURRENT";
  const gl = await prisma.glAccount.findUniqueOrThrow({ where: { code: type === "CURRENT" ? "2010" : type === "SAVINGS" ? "2020" : "2030" } });
  return prisma.account.create({
    data: {
      accountNumber: makeIban(branch.code, 900000 + n),
      customerId,
      branchId,
      type,
      currency: opts.currency ?? "EGP",
      status: opts.status ?? "ACTIVE",
      glAccountId: gl.id,
      interestRateBps: opts.rateBps ?? 0,
    },
  });
}

/** Fund a customer account from the central-bank settlement GL through the real posting engine. */
export async function fund(accountId: string, amountMinor: bigint, currency: Currency = "EGP") {
  return withTx((tx) =>
    postJournal(tx, {
      idempotencyKey: `test-fund:${randomUUID()}`,
      type: "MANUAL",
      description: "test funding",
      currency,
      channel: "SYSTEM",
      skipAml: true,
      lines: [
        { glCode: "1100", debit: amountMinor },
        { accountId, credit: amountMinor },
      ],
    }),
  );
}

export async function ledgerBalanceOfAccount(accountId: string): Promise<bigint> {
  const r = await prisma.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return (r._sum.credit ?? 0n) - (r._sum.debit ?? 0n);
}
