/**
 * Demo seed — fictional Egyptian data, posted through the REAL engines (ledger, teller, transfers,
 * card authorization, loans, deposits, EOD). Nothing is inserted into journal tables directly.
 *
 *   npm run db:seed                      (refuses to run on a non-empty database)
 *   SEED_RESET=1 npm run db:seed         (DEV ONLY: empties every table first; refused when NODE_ENV=production)
 *   npm run db:reset                     (prisma migrate reset: drop, re-migrate, seed)
 *
 * The seed walks a timeline day by day for ~5 months, posting that day's activity with a back-dated
 * posting time, then runs the real End-of-Day batch for that date (interest accrual, loan collection /
 * DPD / penalties, hold expiry, maintenance fees, snapshots and GL reconciliation checks).
 */
process.env.OTP_PROVIDER = "memory"; // 3-D Secure OTPs for seeded e-commerce purchases are read from memory
import { prisma, withTx } from "@/lib/db";
import { ensureReferenceData } from "@/server/bootstrap";
import { postJournal } from "@/server/ledger";
import { hashPassword } from "@/server/auth/password";
import { memoryOutbox } from "@/server/auth/otp";
import { getHsm } from "@/server/cards/hsm";
import { SYSTEM_ACTOR, type Actor } from "@/server/audit";
import type { StaffPrincipal } from "@/server/rbac";
import { addDays, cairoDayStart, todayStr, toDateStr, dateOnly } from "@/lib/dates";
import { toMinor } from "@/lib/money";
import { makeIban } from "@/lib/iban";
import { newCif, createCustomer, enableDigitalBanking } from "@/server/services/customers";
import { createAccountRow, requestStatusChange } from "@/server/services/accounts";
import { cashDeposit, cashWithdrawal } from "@/server/services/teller";
import { executeTransfer, submitBatch, settleBatch } from "@/server/services/transfers";
import { createLoanApplication, disburseLoanTx, loanDecision, applyLoan } from "@/server/services/loans";
import { openTermDepositTx } from "@/server/services/deposits";
import { issueCardTx } from "@/server/services/cards";
import { authorize, capture, refund, setCardPin, openDisputeByCustomer, type Channel } from "@/server/services/card-auth";
import { createAtm, replenishAtm } from "@/server/services/atm";
import { registerDevice, captureCount } from "@/server/services/cash-count";
import { payBillTx } from "@/server/services/portal";
import { createTicket, staffTicketAction } from "@/server/services/tickets";
import { runEod } from "@/server/services/eod";
import { decideApproval, listApprovals } from "@/server/services/approvals";
import { AtmSimulator, PosSimulator } from "@/server/switch/simulators";
import { InProcessSwitch, TimeoutReversalSwitch } from "@/server/switch/adapter";
import type { Currency, StaffRole } from "@prisma/client";

export const STAFF_PASSWORD = "NeoBank@2026";
export const CUSTOMER_PASSWORD = "Portal@2026";
export const CARD_PIN = "2580";
const DAYS = 150;

// ---------- deterministic PRNG so every seed run looks the same ----------
let seed = 20261002;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
let keyN = 0;
const key = (p: string) => `seed-${p}-${++keyN}`;
let stanN = 100000;
const stan = () => String(++stanN % 1_000_000).padStart(6, "0");

/** A Cairo-local wall-clock time on a given business date. */
function at(day: string, h: number, m = 0) {
  return new Date(cairoDayStart(new Date(`${day}T12:00:00Z`)).getTime() + (h * 60 + m) * 60_000);
}
const P = (s: { id: string; username: string; role: StaffRole; branchId: string | null; fullNameAr: string; fullNameEn: string }): StaffPrincipal =>
  ({ id: s.id, username: s.username, role: s.role, branchId: s.branchId, fullNameAr: s.fullNameAr, fullNameEn: s.fullNameEn });
const A = (s: StaffPrincipal): Actor => ({ type: "STAFF", id: s.id, name: s.username, ip: "seed" });
const egp = (n: number) => n.toFixed(2);
const log = (...a: unknown[]) => console.log("[seed]", ...a);

// ---------- master data ----------
const BRANCHES = [
  { code: "0101", nameAr: "فرع القاهرة الرئيسي - وسط البلد", nameEn: "Cairo Main - Downtown", city: "Cairo", address: "15 ش طلعت حرب، وسط البلد، القاهرة", short: "CAI" },
  { code: "0201", nameAr: "فرع الإسكندرية - سموحة", nameEn: "Alexandria - Smouha", city: "Alexandria", address: "22 ش فوزي معاذ، سموحة، الإسكندرية", short: "ALX" },
  { code: "0301", nameAr: "فرع الجيزة - الدقي", nameEn: "Giza - Dokki", city: "Giza", address: "8 ش التحرير، الدقي، الجيزة", short: "GIZ" },
];

type SDef = { u: string; role: StaffRole; b: string | null; ar: string; en: string };
const STAFF: SDef[] = [
  { u: "admin", role: "SUPER_ADMIN", b: null, ar: "مدير النظام", en: "System Administrator" },
  { u: "mgr.cairo", role: "BRANCH_MANAGER", b: "0101", ar: "هشام عبد الرحمن", en: "Hisham Abdelrahman" },
  { u: "mgr.alex", role: "BRANCH_MANAGER", b: "0201", ar: "داليا الشناوي", en: "Dalia El-Shennawy" },
  { u: "mgr.giza", role: "BRANCH_MANAGER", b: "0301", ar: "شريف منصور", en: "Sherif Mansour" },
  { u: "teller.cairo", role: "TELLER", b: "0101", ar: "محمود السيد", en: "Mahmoud El-Sayed" },
  { u: "teller.cairo2", role: "TELLER", b: "0101", ar: "نهى فؤاد", en: "Noha Fouad" },
  { u: "teller.alex", role: "TELLER", b: "0201", ar: "كريم البحيري", en: "Karim El-Beheiry" },
  { u: "teller.giza", role: "TELLER", b: "0301", ar: "رانيا عادل", en: "Rania Adel" },
  { u: "cs.cairo", role: "CUSTOMER_SERVICE", b: "0101", ar: "سارة حسني", en: "Sara Hosny" },
  { u: "cs.alex", role: "CUSTOMER_SERVICE", b: "0201", ar: "ياسمين رشاد", en: "Yasmin Rashad" },
  { u: "cs.giza", role: "CUSTOMER_SERVICE", b: "0301", ar: "أحمد زكي", en: "Ahmed Zaki" },
  { u: "credit.cairo", role: "CREDIT_OFFICER", b: "0101", ar: "مصطفى جلال", en: "Mostafa Galal" },
  { u: "credit.alex", role: "CREDIT_OFFICER", b: "0201", ar: "إيمان الصاوي", en: "Eman El-Sawy" },
  { u: "credit.manager", role: "CREDIT_MANAGER", b: null, ar: "عمرو الدسوقي", en: "Amr El-Desouky" },
  { u: "compliance", role: "COMPLIANCE_OFFICER", b: null, ar: "منى القاضي", en: "Mona El-Kady" },
  { u: "ops", role: "OPERATIONS", b: null, ar: "طارق نصار", en: "Tarek Nassar" },
  { u: "finance", role: "FINANCE", b: null, ar: "هبة الجمال", en: "Heba El-Gammal" },
  { u: "auditor", role: "AUDITOR", b: null, ar: "وليد شكري", en: "Walid Shoukry" },
];

type CDef = { ar: string; en: string; b: string; corp?: boolean; occ: string; income: number; risk?: "LOW" | "MEDIUM" | "HIGH"; fx?: Currency; savings?: boolean; portal?: string };
const CUSTOMERS: CDef[] = [
  { ar: "أحمد حسن عبد العزيز", en: "Ahmed Hassan Abdelaziz", b: "0101", occ: "Software Engineer", income: 45000, savings: true, fx: "USD", portal: "ahmed.hassan" },
  { ar: "منى علي إبراهيم", en: "Mona Ali Ibrahim", b: "0101", occ: "Physician", income: 60000, savings: true, portal: "mona.ali" },
  { ar: "محمد مصطفى كامل", en: "Mohamed Mostafa Kamel", b: "0101", occ: "Accountant", income: 18000 },
  { ar: "فاطمة محمود سالم", en: "Fatma Mahmoud Salem", b: "0101", occ: "Teacher", income: 12000, savings: true },
  { ar: "عمر خالد فاروق", en: "Omar Khaled Farouk", b: "0101", occ: "Sales Manager", income: 30000, fx: "EUR" },
  { ar: "نورهان سامي يوسف", en: "Nourhan Samy Youssef", b: "0101", occ: "Pharmacist", income: 22000, savings: true },
  { ar: "ياسر عبد الله رمضان", en: "Yasser Abdallah Ramadan", b: "0101", occ: "Civil Engineer", income: 35000 },
  { ar: "هدى أشرف الشريف", en: "Hoda Ashraf El-Sherif", b: "0101", occ: "Architect", income: 28000, fx: "SAR" },
  { ar: "شركة النيل للتوريدات ش.م.م", en: "Nile Supplies LLC", b: "0101", corp: true, occ: "Trading", income: 0, risk: "MEDIUM" },
  { ar: "إسلام جمال حافظ", en: "Islam Gamal Hafez", b: "0101", occ: "Driver", income: 9000 },
  { ar: "رحاب سعيد عثمان", en: "Rehab Saeed Osman", b: "0101", occ: "Nurse", income: 11000 },
  { ar: "كريم وائل البنا", en: "Karim Wael El-Banna", b: "0101", occ: "Business Owner", income: 80000, risk: "HIGH", fx: "USD" },
  { ar: "خالد إبراهيم الإسكندراني", en: "Khaled Ibrahim El-Iskandarani", b: "0201", occ: "Port Officer", income: 26000, savings: true, portal: "khaled.ibrahim" },
  { ar: "سلمى طارق مرسي", en: "Salma Tarek Morsy", b: "0201", occ: "Lecturer", income: 20000 },
  { ar: "مينا جرجس عزيز", en: "Mina Girgis Aziz", b: "0201", occ: "Dentist", income: 40000, savings: true, fx: "EUR" },
  { ar: "أسماء رضا حمدي", en: "Asmaa Reda Hamdy", b: "0201", occ: "HR Specialist", income: 15000 },
  { ar: "حسام الدين فتحي", en: "Hossam El-Din Fathy", b: "0201", occ: "Fisherman", income: 7000 },
  { ar: "دينا مجدي لطفي", en: "Dina Magdy Lotfy", b: "0201", occ: "Designer", income: 17000, savings: true },
  { ar: "شركة البحر المتوسط للشحن", en: "Mediterranean Shipping Co.", b: "0201", corp: true, occ: "Logistics", income: 0, fx: "USD" },
  { ar: "عبد الرحمن نبيل صقر", en: "Abdelrahman Nabil Saqr", b: "0201", occ: "Mechanic", income: 10000 },
  { ar: "مريم عادل شاكر", en: "Mariam Adel Shaker", b: "0201", occ: "Lawyer", income: 32000 },
  { ar: "محمود عبد الفتاح غنيم", en: "Mahmoud Abdelfattah Ghoneim", b: "0301", occ: "Tour Guide", income: 14000, fx: "USD" },
  { ar: "إيناس حمدي السباعي", en: "Enas Hamdy El-Sebaey", b: "0301", occ: "Bank Clerk", income: 16000, savings: true },
  { ar: "طارق سمير الجوهري", en: "Tarek Samir El-Gohary", b: "0301", occ: "Contractor", income: 50000, savings: true },
  { ar: "شيماء أحمد بدوي", en: "Shaimaa Ahmed Badawy", b: "0301", occ: "Journalist", income: 13000 },
  { ar: "مصطفى هاني رزق", en: "Mostafa Hany Rizk", b: "0301", occ: "Student", income: 3000 },
  { ar: "نادية فاروق الحلواني", en: "Nadia Farouk El-Helwany", b: "0301", occ: "Retired", income: 8000, savings: true },
  { ar: "حازم أيمن قنديل", en: "Hazem Ayman Kandil", b: "0301", occ: "Chef", income: 19000 },
  { ar: "رنا وليد الشافعي", en: "Rana Walid El-Shafei", b: "0301", occ: "Marketing Lead", income: 27000, fx: "SAR" },
  { ar: "مؤسسة الأهرام للمقاولات", en: "Al-Ahram Contracting Est.", b: "0301", corp: true, occ: "Construction", income: 0 },
];

const MERCHANTS = {
  POS: [
    { name: "Carrefour Maadi", mcc: "5411", id: "MERCARREF1", lo: 300, hi: 3500 },
    { name: "Seoudi Market", mcc: "5411", id: "MERSEOUDI1", lo: 150, hi: 1800 },
    { name: "Wadi Degla Pharmacy", mcc: "5912", id: "MERPHARM01", lo: 80, hi: 900 },
    { name: "Mobil Fuel Station", mcc: "5541", id: "MERFUEL001", lo: 300, hi: 1200 },
    { name: "B.TECH Electronics", mcc: "5732", id: "MERBTECH01", lo: 1500, hi: 9000 },
    { name: "Zara City Stars", mcc: "5651", id: "MERZARACS1", lo: 900, hi: 4500 },
  ],
  CONTACTLESS: [
    { name: "Costa Coffee Zamalek", mcc: "5814", id: "MERCOSTA01", lo: 60, hi: 250 },
    { name: "Metro Market", mcc: "5411", id: "MERMETRO01", lo: 100, hi: 600 },
    { name: "Gad Restaurant", mcc: "5812", id: "MERGAD0001", lo: 80, hi: 450 },
  ],
  ECOM: [
    { name: "Jumia Egypt", mcc: "5999", id: "MERJUMIA01", lo: 250, hi: 4000, country: "EG" },
    { name: "Talabat", mcc: "5812", id: "MERTALABAT", lo: 120, hi: 700, country: "EG" },
    { name: "Uber Egypt", mcc: "4121", id: "MERUBEREG1", lo: 60, hi: 350, country: "EG" },
    { name: "Netflix", mcc: "4899", id: "MERNETFLIX", lo: 120, hi: 240, country: "NL" },
    { name: "Amazon.com", mcc: "5942", id: "MERAMAZON1", lo: 800, hi: 6000, country: "US" },
  ],
};

async function main() {
  if (process.env.SEED_RESET === "1") {
    if (process.env.NODE_ENV === "production") throw new Error("SEED_RESET is refused in production");
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const sq of ["nb_journal_seq", "nb_cif_seq", "nb_account_seq", "nb_loan_seq", "nb_transfer_seq", "nb_ticket_seq", "nb_alert_seq", "nb_case_seq", "nb_batch_seq", "nb_bill_seq", "nb_card_seq", "nb_auth_seq", "nb_dispute_seq"]) {
      await prisma.$executeRawUnsafe(`ALTER SEQUENCE IF EXISTS ${sq} RESTART`);
    }
    log("dev database emptied (SEED_RESET=1)");
  }
  if ((await prisma.branch.count()) > 0) {
    console.error("[seed] Database already contains data. Use `npm run db:reset` to drop, re-migrate and re-seed.");
    process.exit(1);
  }
  const t0 = Date.now();
  await ensureReferenceData(prisma);
  const today = todayStr();
  const start = toDateStr(addDays(dateOnly(today), -DAYS));
  const days: string[] = [];
  for (let i = 0; i < DAYS; i++) days.push(toDateStr(addDays(dateOnly(start), i)));
  log(`timeline ${start} → ${days[days.length - 1]} (+ live activity today ${today})`);

  // ---------- branches, capital, staff, tills ----------
  const branches: Record<string, { id: string; code: string; short: string }> = {};
  for (const b of BRANCHES) {
    const row = await prisma.branch.create({ data: { code: b.code, nameAr: b.nameAr, nameEn: b.nameEn, city: b.city, address: b.address, createdAt: at(start, 8) } });
    branches[b.code] = { id: row.id, code: b.code, short: b.short };
  }
  const CAPITAL: Record<Currency, bigint> = { EGP: toMinor("2000000000"), USD: toMinor("20000000"), EUR: toMinor("5000000"), SAR: toMinor("10000000") };
  for (const ccy of Object.keys(CAPITAL) as Currency[]) {
    await withTx((tx) => postJournal(tx, {
      idempotencyKey: `seed-capital-${ccy}`, type: "MANUAL", currency: ccy, channel: "SYSTEM", skipAml: true, postedAt: at(start, 8), valueDate: start,
      description: `Paid-in capital (${ccy}) deposited at the Central Bank`, lines: [{ glCode: "1100", debit: CAPITAL[ccy] }, { glCode: "3010", credit: CAPITAL[ccy] }],
    }));
  }

  const pwHash = await hashPassword(STAFF_PASSWORD);
  const staff: Record<string, StaffPrincipal> = {};
  for (const s of STAFF) {
    const row = await prisma.staff.create({ data: { username: s.u, email: `${s.u}@neobank.demo`, fullNameAr: s.ar, fullNameEn: s.en, passwordHash: pwHash, role: s.role, branchId: s.b ? branches[s.b].id : null, createdAt: at(start, 8) } });
    staff[s.u] = P(row);
  }

  const vaults: Record<string, Record<string, string>> = {};
  const tellerTill: Record<string, string> = {};
  for (const b of BRANCHES) {
    const br = branches[b.code];
    vaults[b.code] = {};
    for (const ccy of ["EGP", "USD", "EUR", "SAR"] as Currency[]) {
      const v = await prisma.till.create({ data: { code: `VLT-${b.short}-${ccy}`, branchId: br.id, kind: "VAULT", currency: ccy, status: "OPEN" } });
      vaults[b.code][ccy] = v.id;
      const amt = ccy === "EGP" ? toMinor("30000000") : toMinor("300000");
      await withTx((tx) => postJournal(tx, {
        idempotencyKey: `seed-vault-${b.short}-${ccy}`, type: "TILL_TRANSFER", currency: ccy, channel: "BRANCH", branchId: br.id, postedAt: at(start, 8, 30), valueDate: start,
        description: `Cash delivered from the Central Bank to ${b.nameEn} vault`, lines: [{ tillId: v.id, debit: amt }, { glCode: "1100", credit: amt }],
      }));
    }
  }
  for (const s of STAFF.filter((x) => x.role === "TELLER")) {
    const b = BRANCHES.find((x) => x.code === s.b)!;
    for (const ccy of (s.u === "teller.cairo" ? ["EGP", "USD"] : ["EGP"]) as Currency[]) {
      const t = await prisma.till.create({ data: { code: `TLR-${b.short}-${s.u.split(".")[1].toUpperCase()}-${ccy}`, branchId: branches[b.code].id, kind: "TELLER", currency: ccy, status: "OPEN", assignedToId: staff[s.u].id } });
      if (ccy === "EGP") tellerTill[s.u] = t.id;
      const amt = ccy === "EGP" ? toMinor("1500000") : toMinor("50000");
      await withTx((tx) => postJournal(tx, {
        idempotencyKey: `seed-till-float-${t.code}`, type: "TILL_TRANSFER", currency: ccy, channel: "BRANCH", branchId: branches[b.code].id, staffId: staff[`mgr.${b.short === "CAI" ? "cairo" : b.short === "ALX" ? "alex" : "giza"}`].id,
        postedAt: at(start, 8, 45), valueDate: start, description: `Opening float ${t.code}`, lines: [{ tillId: t.id, debit: amt }, { tillId: vaults[b.code][ccy], credit: amt }],
      }));
    }
  }
  log("branches, capital, vaults, staff, tills ready");

  // ---------- customers & accounts (opened through the account engine) ----------
  type Cust = { id: string; def: CDef; branch: string; phone: string; current: string; currentIban: string; savings?: string; fx?: string; fxCcy?: Currency; card?: { id: string; token: string }; loanAcc?: string };
  const custs: Cust[] = [];
  let i = 0;
  for (const c of CUSTOMERS) {
    i++;
    const opened = days[Math.min(5 + i, 30)];
    const phone = `+20${pick(["10", "11", "12", "15"])}${String(10000000 + i * 7919).slice(0, 8)}`;
    const row = await prisma.customer.create({
      data: {
        cif: await newCif(prisma), type: c.corp ? "CORPORATE" : "INDIVIDUAL", nameAr: c.ar, nameEn: c.en,
        nationalId: c.corp ? undefined : `2${String(70 + (i % 30)).padStart(2, "0")}${String((i % 12) + 1).padStart(2, "0")}${String((i % 27) + 1).padStart(2, "0")}${String(1000000 + i * 3571).slice(-7)}`,
        commercialRegNo: c.corp ? `CR-${100000 + i}` : undefined, taxId: c.corp ? `TAX-${500000000 + i}` : undefined,
        phone, email: `${c.en.toLowerCase().replace(/[^a-z]+/g, ".").replace(/\.+$/, "")}@example.com`, dateOfBirth: c.corp ? undefined : new Date(Date.UTC(1965 + (i * 7) % 35, i % 12, 1 + (i % 27))),
        address: `${BRANCHES.find((b) => b.code === c.b)!.city}, Egypt`, occupation: c.occ, monthlyIncome: c.income ? toMinor(String(c.income)) : undefined,
        branchId: branches[c.b].id, kycStatus: "APPROVED", riskRating: c.risk ?? "LOW", createdById: staff[`cs.${c.b === "0101" ? "cairo" : c.b === "0201" ? "alex" : "giza"}`].id,
        createdAt: at(opened, 10), source: "BRANCH",
      },
    });
    await prisma.kycDocument.create({ data: { customerId: row.id, docType: c.corp ? "COMMERCIAL_REGISTER" : "NATIONAL_ID", docNumber: c.corp ? `CR-${100000 + i}` : row.nationalId, fileName: c.corp ? "commercial-register.pdf" : "national-id-scan.pdf", verified: true, verifiedById: staff[`mgr.${c.b === "0101" ? "cairo" : c.b === "0201" ? "alex" : "giza"}`].id, uploadedAt: at(opened, 10, 5) } }).catch(() => undefined);
    const accs = await withTx(async (tx) => {
      const cur = await createAccountRow(tx, { customerId: row.id, type: "CURRENT", currency: "EGP", openedAt: at(opened, 10, 10), nickname: c.corp ? "Operating account" : "الحساب الجاري" });
      const sav = c.savings ? await createAccountRow(tx, { customerId: row.id, type: "SAVINGS", currency: "EGP", openedAt: at(opened, 10, 12), nickname: "توفير" }) : undefined;
      const fx = c.fx ? await createAccountRow(tx, { customerId: row.id, type: c.corp ? "CURRENT" : "SAVINGS", currency: c.fx, openedAt: at(opened, 10, 14), nickname: `${c.fx}` }) : undefined;
      return { cur, sav, fx };
    });
    custs.push({ id: row.id, def: c, branch: c.b, phone, current: accs.cur.id, currentIban: accs.cur.accountNumber, savings: accs.sav?.id, fx: accs.fx?.id, fxCcy: c.fx });
  }
  log(`${custs.length} customers with accounts`);

  const tellerOf = (b: string) => (b === "0101" ? pick(["teller.cairo", "teller.cairo2"]) : b === "0201" ? "teller.alex" : "teller.giza");
  const salaryCredit = async (c: Cust, day: string) => {
    const amt = c.def.corp ? between(250000, 900000) : c.def.income;
    await withTx((tx) => postJournal(tx, {
      idempotencyKey: key(`salary-${c.id}-${day}`), type: "INCOMING_TRANSFER", currency: "EGP", channel: "SYSTEM", branchId: branches[c.branch].id, postedAt: at(day, 9, between(0, 50)), valueDate: day,
      description: c.def.corp ? "Incoming customer payments via ACH" : "Salary credit via ACH (payroll)", reference: `ACH${day.replace(/-/g, "")}`,
      lines: [{ glCode: "1100", debit: toMinor(String(amt)) }, { accountId: c.current, credit: toMinor(String(amt)), narrative: c.def.corp ? "Incoming ACH collections" : "Salary" }],
    }));
  };

  // Opening deposits (teller cash through the real teller service) and first salary.
  for (const c of custs) {
    const opened = toDateStr(await prisma.account.findUniqueOrThrow({ where: { id: c.current } }).then((a) => a.openedAt));
    const t = tellerOf(c.branch);
    await cashDeposit(staff[t], A(staff[t]), { accountId: c.current, amount: egp(c.def.corp ? 750000 : between(5000, 40000)), narrative: "Opening cash deposit", idempotencyKey: key("open-cash") }, { postedAt: at(opened, 10, 30) });
    if (c.fx && c.fxCcy) {
      const fxAmt = toMinor(String(between(1500, 25000)));
      await withTx((tx) => postJournal(tx, {
        idempotencyKey: key("fx-open"), type: "INCOMING_TRANSFER", currency: c.fxCcy!, channel: "SYSTEM", postedAt: at(opened, 11), valueDate: opened, branchId: branches[c.branch].id,
        description: `Incoming SWIFT transfer (${c.fxCcy})`, lines: [{ glCode: "1100", debit: fxAmt }, { accountId: c.fx!, credit: fxAmt, narrative: "Incoming SWIFT" }],
      }));
    }
  }
  log("opening deposits posted");

  // ---------- cards (issued via the card engine, PIN set through the HSM) ----------
  for (const c of custs.filter((x) => !x.def.corp).slice(0, 24)) {
    const day = days[35];
    const card = await withTx((tx) => issueCardTx(tx, c.current, { chargeFee: true, postedAt: at(day, 12), staffId: staff[`cs.${c.branch === "0101" ? "cairo" : c.branch === "0201" ? "alex" : "giza"}`].id }));
    await setCardPin(card.id, getHsm().encryptPinBlock(CARD_PIN, card.token));
    if (["Ahmed Hassan Abdelaziz", "Mona Ali Ibrahim", "Karim Wael El-Banna", "Mina Girgis Aziz"].includes(c.def.en)) await prisma.card.update({ where: { id: card.id }, data: { internationalEnabled: true } });
    c.card = { id: card.id, token: card.token };
  }
  log("cards issued");

  // ---------- ATMs and counters ----------
  const atmDefs = [
    { tid: "NBCAI001", b: "0101", ar: "فرع وسط البلد - مدخل الفرع", en: "Downtown branch lobby" },
    { tid: "NBCAI002", b: "0101", ar: "سيتي ستارز مول - مدينة نصر", en: "City Stars Mall, Nasr City" },
    { tid: "NBALX001", b: "0201", ar: "فرع سموحة", en: "Smouha branch" },
    { tid: "NBGIZ001", b: "0301", ar: "فرع الدقي - ميدان المساحة", en: "Dokki branch, El-Messaha Sq." },
  ];
  const atms: { id: string; tid: string; b: string }[] = [];
  for (const d of atmDefs) {
    const mgr = staff[d.b === "0101" ? "mgr.cairo" : d.b === "0201" ? "mgr.alex" : "mgr.giza"];
    const atm = await createAtm(mgr, A(mgr), { terminalId: d.tid, branchId: branches[d.b].id, locationAr: d.ar, locationEn: d.en });
    await replenishAtm(mgr, A(mgr), { atmId: atm.id, cassettes: [{ position: 1, notes: 1500 }, { position: 2, notes: 2000 }, { position: 3, notes: 1500 }, { position: 4, notes: 1000 }], idempotencyKey: key("atm-load") }, { postedAt: at(days[36], 7) });
    atms.push({ id: atm.id, tid: d.tid, b: d.b });
  }
  const counters = [
    { deviceId: "CNT-CAI-01", b: "0101", model: "Glory GFS-220 (simulated)", driver: "SIMULATOR" as const },
    { deviceId: "CNT-CAI-02", b: "0101", model: "Magner 175 (TCP bridge)", driver: "TCP" as const, address: "127.0.0.1:9100" },
    { deviceId: "CNT-ALX-01", b: "0201", model: "Glory GFS-220 (simulated)", driver: "SIMULATOR" as const },
    { deviceId: "CNT-GIZ-01", b: "0301", model: "Cassida 6600 (simulated)", driver: "SIMULATOR" as const },
  ];
  for (const d of counters) {
    const mgr = staff[d.b === "0101" ? "mgr.cairo" : d.b === "0201" ? "mgr.alex" : "mgr.giza"];
    await registerDevice(mgr, A(mgr), { deviceId: d.deviceId, branchId: branches[d.b].id, model: d.model, driver: d.driver, address: d.address });
  }
  log("ATMs loaded, cash counters registered");

  // ---------- helpers for card activity ----------
  const holds: { id: string; day: number }[] = [];
  const captured: string[] = [];
  const cardTxn = async (c: Cust, dayIdx: number, channel: Channel, h: number) => {
    if (!c.card) return;
    const day = days[dayIdx];
    const postedAt = at(day, h, between(0, 59));
    const s = stan();
    if (channel === "ATM") {
      const own = rnd() < 0.75;
      const atm = own ? pick(atms.filter((a) => a.b === c.branch).concat(atms)) : null;
      const r = await authorize({ cardToken: c.card.token, channel: "ATM", txnType: "CASH_WITHDRAWAL", amount: toMinor(String(pick([500, 1000, 1500, 2000, 3000, 4000]))), currency: "EGP", stan: s,
        acquirerId: own ? undefined : "EBC00001", terminalId: own ? atm!.tid : `OTH${String(between(10000, 99999))}`, merchant: own ? undefined : { name: pick(["Demo National Bank ATM", "Demo Misr Bank ATM"]), mcc: "6011", country: "EG" },
        pinBlock: getHsm().encryptPinBlock(CARD_PIN, c.card.token), entryMode: "051", postedAt });
      return r;
    }
    const m = pick(MERCHANTS[channel === "POS" ? "POS" : channel === "CONTACTLESS" ? "CONTACTLESS" : "ECOM"]) as { name: string; mcc: string; id: string; lo: number; hi: number; country?: string };
    const amount = toMinor(String(between(m.lo, m.hi)));
    const base = { cardToken: c.card.token, channel, txnType: "PURCHASE" as const, amount, currency: "EGP" as Currency, stan: s, acquirerId: "NEOBANK", merchant: { name: m.name, id: m.id, mcc: m.mcc, country: m.country ?? "EG" }, postedAt };
    let r;
    if (channel === "ECOM") {
      const ch = await authorize({ ...base, entryMode: "812" });
      if (ch.responseCode !== "1A" || !ch.challengeId) return ch;
      r = await authorize({ ...base, entryMode: "812", threeDs: { challengeId: ch.challengeId, code: memoryOutbox.get(c.phone)! } });
    } else {
      r = await authorize({ ...base, entryMode: channel === "POS" ? "051" : "071", pinBlock: channel === "POS" || amount > 60000n ? getHsm().encryptPinBlock(CARD_PIN, c.card.token) : undefined });
    }
    if (r.approved && r.authorizationId && r.status === "AUTHORIZED") holds.push({ id: r.authorizationId, day: dayIdx });
    return r;
  };

  // ---------- loans set-up dates ----------
  const loanPlan = [
    { who: "Yasser Abdallah Ramadan", product: "AUTO", amount: 450000, term: 60, day: 20 },
    { who: "Ahmed Hassan Abdelaziz", product: "PERSONAL", amount: 120000, term: 36, day: 30 },
    { who: "Salma Tarek Morsy", product: "PERSONAL", amount: 60000, term: 24, day: 45 },
    { who: "Tarek Samir El-Gohary", product: "PERSONAL", amount: 200000, term: 48, day: 60 },
    { who: "Nile Supplies LLC", product: "SME", amount: 1500000, term: 24, day: 70 },
    { who: "Hazem Ayman Kandil", product: "PERSONAL", amount: 40000, term: 12, day: 100 },
    { who: "Islam Gamal Hafez", product: "PERSONAL", amount: 30000, term: 12, day: 25, bad: true }, // → NPL (>90 DPD)
    { who: "Abdelrahman Nabil Saqr", product: "PERSONAL", amount: 25000, term: 12, day: 84, bad: true }, // → ~35 DPD
  ];
  const tdPlan = [
    { who: "Mona Ali Ibrahim", amount: 300000, term: 12, day: 40, payout: "CAPITALIZE" as const },
    { who: "Ahmed Hassan Abdelaziz", amount: 100000, term: 3, day: 32, payout: "PAYOUT" as const }, // matures inside the window
    { who: "Nadia Farouk El-Helwany", amount: 250000, term: 6, day: 50, payout: "PAYOUT" as const },
    { who: "Mina Girgis Aziz", amount: 150000, term: 24, day: 75, payout: "CAPITALIZE" as const },
    { who: "Khaled Ibrahim El-Iskandarani", amount: 80000, term: 6, day: 110, payout: "CAPITALIZE" as const },
    { who: "Tarek Samir El-Gohary", amount: 500000, term: 36, day: 90, payout: "PAYOUT" as const },
  ];
  const byName = (n: string) => custs.find((c) => c.def.en === n)!;
  const products = Object.fromEntries((await prisma.loanProduct.findMany()).map((p) => [p.code, p.id]));
  const individuals = custs.filter((c) => !c.def.corp);
  let declines = 0, approvals = 0;

  // ---------- the timeline ----------
  for (let d = 0; d < DAYS; d++) {
    const day = days[d];
    const dom = Number(day.slice(8, 10));
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 5 = Friday (weekend in Egypt)
    const weekend = dow === 5 || dow === 6;

    if (dom === 25 || (d === 2)) for (const c of custs) if (c.def.corp ? dom === 25 : true) await salaryCredit(c, day);

    if (!weekend && d > 6) {
      // branch cash
      for (let k = 0; k < between(1, 4); k++) {
        const c = pick(custs); const t = tellerOf(c.branch);
        const dep = rnd() < 0.6;
        const amt = egp(dep ? between(1000, 30000) : between(500, 8000));
        try {
          if (dep) await cashDeposit(staff[t], A(staff[t]), { accountId: c.current, amount: amt, idempotencyKey: key("cash") }, { postedAt: at(day, between(9, 14), between(0, 59)) });
          else await cashWithdrawal(staff[t], A(staff[t]), { accountId: c.current, amount: amt, idempotencyKey: key("cash") }, { postedAt: at(day, between(9, 14), between(0, 59)) });
        } catch { /* insufficient funds etc. are realistic declines */ }
      }
      // internal transfers between customers
      for (let k = 0; k < between(1, 3); k++) {
        const a = pick(custs), b = pick(custs);
        if (a === b) continue;
        await executeTransfer({ kind: "SYSTEM", actor: SYSTEM_ACTOR, postedAt: at(day, between(10, 20), between(0, 59)) }, { fromAccountId: a.current, toAccountNumber: b.currentIban, toName: b.def.en, amount: egp(between(200, 6000)), description: pick(["إيجار", "Rent share", "سداد دين", "Gift", "Family support", "Invoice payment"]), idempotencyKey: key("xfer") }).catch(() => undefined);
      }
      // corporate large cash (AML CTR alerts)
      if (d % 37 === 11) {
        const corp = pick(custs.filter((c) => c.def.corp)); const t = tellerOf(corp.branch);
        await cashDeposit(staff[t], A(staff[t]), { accountId: corp.current, amount: egp(between(550000, 900000)), narrative: "Daily sales cash", idempotencyKey: key("ctr") }, { postedAt: at(day, 12) }).catch(() => undefined);
      }
    }
    // external transfers to other banks (clearing) — settled by Operations
    if (!weekend && d % 6 === 3) {
      const a = pick(individuals);
      await executeTransfer({ kind: "SYSTEM", actor: SYSTEM_ACTOR, postedAt: at(day, 13) }, { fromAccountId: a.current, toAccountNumber: makeIban(pick(["0010", "0020", "0030"]), between(1000, 99999), "EG", pick(["0001", "0002", "0003"])), toName: "Demo National Bank customer", amount: egp(between(1000, 9000)), idempotencyKey: key("ext") }).catch(() => undefined);
    }
    // savings sweep
    if (dom === 26) for (const c of custs.filter((x) => x.savings)) {
      const acc = c.savings!;
      await withTx(async (tx) => {
        const iban = (await tx.account.findUniqueOrThrow({ where: { id: acc } })).accountNumber;
        return iban;
      }).then((iban) => executeTransfer({ kind: "SYSTEM", actor: SYSTEM_ACTOR, postedAt: at(day, 8) }, { fromAccountId: c.current, toAccountNumber: iban, amount: egp(Math.round((c.def.income || 10000) * 0.2)), description: "Monthly savings", idempotencyKey: key("sweep") })).catch(() => undefined);
    }
    // bill payments
    if (dom >= 3 && dom <= 8) for (const c of individuals.filter((_, idx) => idx % 3 === dom % 3)) {
      await payBillTx(c.id, SYSTEM_ACTOR, { accountId: c.current, billerCode: pick(["MOCK-ELEC", "MOCK-WATER", "MOCK-GAS", "MOCK-MOBILE", "MOCK-NET"]), billReference: `${100000 + custs.indexOf(c) * 37}`, amount: egp(between(90, 1400)), idempotencyKey: key("bill") }, at(day, 19, 30)).catch(() => undefined);
    }
    // card activity across all channels
    if (d >= 36) {
      for (let k = 0; k < between(4, 9); k++) {
        const c = pick(individuals.filter((x) => x.card));
        const channel = pick<Channel>(["POS", "POS", "CONTACTLESS", "CONTACTLESS", "ECOM", "ECOM", "ATM", "ATM"]);
        try {
          const r = await cardTxn(c, d, channel, between(9, 22));
          if (r?.approved) approvals++; else declines++;
        } catch (e) { declines++; if (process.env.SEED_DEBUG) console.warn(e); }
      }
      // merchants settle (capture) most holds after 1–2 days; some are partially captured (tips/fuel), some never → expire at EOD
      for (const h of holds.filter((x) => x.day === d - 1 || x.day === d - 2)) {
        if (captured.includes(h.id)) continue;
        if (rnd() < 0.12) continue; // left to expire
        const a = await prisma.cardAuthorization.findUnique({ where: { id: h.id } });
        if (!a || a.status !== "AUTHORIZED") continue;
        const amt = a.merchantName?.includes("Fuel") ? (a.amount * 9n) / 10n : undefined;
        await capture(h.id, amt, { postedAt: at(day, 4) }).catch(() => undefined);
        captured.push(h.id);
      }
      if (d % 9 === 0 && captured.length > 5) {
        const id = pick(captured.slice(-20));
        const a = await prisma.cardAuthorization.findUnique({ where: { id } });
        if (a && a.status === "CAPTURED") await refund(id, rnd() < 0.5 ? a.capturedAmount : a.capturedAmount / 2n, { idempotencyKey: key("refund"), postedAt: at(day, 15) }).catch(() => undefined);
      }
    }
    // cards & ATM: periodic ATM replenishment
    if (d > 36 && d % 14 === 0) for (const atm of atms) {
      const mgr = staff[atm.b === "0101" ? "mgr.cairo" : atm.b === "0201" ? "mgr.alex" : "mgr.giza"];
      await replenishAtm(mgr, A(mgr), { atmId: atm.id, cassettes: [{ position: 1, notes: 300 }, { position: 2, notes: 400 }, { position: 3, notes: 300 }], idempotencyKey: key("atm-top") }, { postedAt: at(day, 7) });
    }
    // loans
    for (const lp of loanPlan.filter((x) => x.day === d)) {
      const c = byName(lp.who);
      let target = c.current;
      if (lp.bad) {
        // a separate account receives the loan and is emptied right away → instalments cannot be collected
        const acc = await withTx((tx) => createAccountRow(tx, { customerId: c.id, type: "CURRENT", currency: "EGP", openedAt: at(day, 9), nickname: "Loan account" }));
        target = acc.id;
      }
      const officer = staff[c.branch === "0201" ? "credit.alex" : "credit.cairo"];
      const loan = await withTx((tx) => createLoanApplication(tx, { customerId: c.id, productId: products[lp.product], amount: egp(lp.amount), termMonths: lp.term, accountId: target, purpose: lp.product === "AUTO" ? "Car purchase" : lp.product === "SME" ? "Working capital" : "Personal needs" }, { staffId: officer.id, channel: "BRANCH", createdAt: at(day, 9, 30) }));
      // 4-eyes: officer recommends, credit manager approves (status set with historical timestamps)
      await prisma.loan.update({ where: { id: loan.id }, data: { status: "APPROVED", recommendedById: officer.id, recommendedAt: at(day, 10), approvedById: staff["credit.manager"].id, approvedAt: at(day, 11) } });
      await withTx((tx) => disburseLoanTx(tx, loan.id, { staffId: staff["credit.manager"].id, postedAt: at(day, 12), valueDate: day }));
      if (lp.bad) {
        const acc = await prisma.account.findUniqueOrThrow({ where: { id: target } });
        await executeTransfer({ kind: "SYSTEM", actor: SYSTEM_ACTOR, postedAt: at(day, 15) }, { fromAccountId: target, toAccountNumber: c.currentIban, amount: (Number(acc.balance) / 100).toFixed(2), description: "Transfer of loan proceeds", idempotencyKey: key("drain") });
      }
    }
    // term deposits
    for (const td of tdPlan.filter((x) => x.day === d)) {
      const c = byName(td.who);
      const src = c.savings ?? c.current;
      await withTx((tx) => postJournal(tx, {
        idempotencyKey: key("td-fund"), type: "INCOMING_TRANSFER", currency: "EGP", channel: "SYSTEM", postedAt: at(day, 9), valueDate: day, branchId: branches[c.branch].id,
        description: "Incoming transfer from another bank (ACH)", lines: [{ glCode: "1100", debit: toMinor(String(td.amount)) }, { accountId: src, credit: toMinor(String(td.amount)) }],
      }));
      await withTx((tx) => openTermDepositTx(tx, { sourceAccountId: src, amount: egp(td.amount), termMonths: td.term, interestPayout: td.payout, idempotencyKey: key("td") }, { customerId: c.id, channel: "BRANCH", staffId: staff[`cs.${c.branch === "0101" ? "cairo" : c.branch === "0201" ? "alex" : "giza"}`].id, postedAt: at(day, 11) }));
    }
    // clearing: Operations submits & settles the outgoing batch twice a week
    if (dow === 1 || dow === 4) {
      for (const b of await prisma.clearingBatch.findMany({ where: { status: "OPEN" } })) {
        await submitBatch(staff.ops, A(staff.ops), b.id).catch(() => undefined);
        await settleBatch(staff.ops, A(staff.ops), b.id).catch(() => undefined);
      }
    }

    await runEod(day, { postedAt: at(day, 23, 30) });
    if (d % 15 === 0) log(`day ${d + 1}/${DAYS} ${day} done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  log(`card authorizations: ${approvals} approved, ${declines} declined`);

  // ---------- today: live activity through the real channels (ISO 8583 switch, simulators, services) ----------
  const sw = new TimeoutReversalSwitch(new InProcessSwitch(), 30_000);
  const cardHolders = individuals.filter((c) => c.card);
  for (const c of cardHolders.slice(0, 6)) {
    await new AtmSimulator(pick(atms).tid, sw).withdraw(c.card!.token, CARD_PIN, toMinor(pick(["500", "1000", "2000"])));
  }
  for (const c of cardHolders.slice(3, 10)) {
    const pos = new PosSimulator(sw, { id: "MERCARREF1", name: "Carrefour Maadi", mcc: "5411", city: "CAIRO", country: "EG" });
    await pos.purchase({ cardToken: c.card!.token, amount: toMinor(String(between(200, 2500))), mode: "CHIP", pin: CARD_PIN });
    const tap = new PosSimulator(sw, { id: "MERCOSTA01", name: "Costa Coffee Zamalek", mcc: "5814", city: "CAIRO", country: "EG" });
    await tap.purchase({ cardToken: c.card!.token, amount: toMinor(String(between(60, 220))), mode: "CONTACTLESS" });
  }
  // a declined online purchase (customer disabled online payments) — shows per-channel toggles
  const noOnline = cardHolders[7];
  await prisma.card.update({ where: { id: noOnline.card!.id }, data: { onlineEnabled: false } });
  await authorize({ cardToken: noOnline.card!.token, channel: "ECOM", txnType: "PURCHASE", amount: toMinor("899"), currency: "EGP", stan: stan(), merchant: { name: "Jumia Egypt", id: "MERJUMIA01", mcc: "5999", country: "EG" } });

  // teller activity today (with a cash counter session bound to a deposit)
  const tc = staff["teller.cairo"];
  const sess = await captureCount(tc, A(tc), { deviceId: "CNT-CAI-01", purpose: "DEPOSIT", currency: "EGP", tillId: tellerTill["teller.cairo"], simulate: { denominations: { "20000": 50, "10000": 20 } } }) as { id: string; total?: bigint };
  await cashDeposit(tc, A(tc), { accountId: byName("Mohamed Mostafa Kamel").current, amount: "12000.00", countSessionId: sess.id, narrative: "Cash deposit (counted by CNT-CAI-01)", idempotencyKey: key("cnt-dep") });
  await cashDeposit(tc, A(tc), { accountId: byName("Fatma Mahmoud Salem").current, amount: "3500.00", idempotencyKey: key("today-dep") });
  await cashDeposit(staff["teller.giza"], A(staff["teller.giza"]), { accountId: byName("Shaimaa Ahmed Badawy").current, amount: "2200.00", idempotencyKey: key("today-dep") });

  // ---------- disputes ----------
  const disputeOn = await prisma.cardAuthorization.findFirst({ where: { status: "CAPTURED", channel: "ECOM", customerId: byName("Ahmed Hassan Abdelaziz").id } })
    ?? await prisma.cardAuthorization.findFirst({ where: { status: "CAPTURED", customerId: { in: custs.filter((x) => x.def.portal).map((x) => x.id) } } })
    ?? await prisma.cardAuthorization.findFirst({ where: { status: "CAPTURED" } });
  if (disputeOn) await openDisputeByCustomer(disputeOn.customerId, SYSTEM_ACTOR, { authorizationId: disputeOn.id, reason: "NOT_RECOGNISED", description: "لا أتذكر هذه العملية / I do not recognise this purchase" });
  const atmDisp = await prisma.cardAuthorization.findFirst({ where: { channel: "ATM", status: "COMPLETED", acquirer: "OWN" }, orderBy: { createdAt: "desc" } });
  if (atmDisp) await openDisputeByCustomer(atmDisp.customerId, SYSTEM_ACTOR, { authorizationId: atmDisp.id, reason: "CASH_NOT_DISPENSED", description: "The ATM did not dispense cash" });

  // ---------- portal users (enabled by customer service) ----------
  for (const c of custs.filter((x) => x.def.portal)) {
    const cs = staff[`cs.${c.branch === "0101" ? "cairo" : c.branch === "0201" ? "alex" : "giza"}`];
    await enableDigitalBanking(cs, A(cs), c.id, { username: c.def.portal!, password: CUSTOMER_PASSWORD });
    await prisma.beneficiary.create({ data: { customerId: c.id, name: "Mohamed Mostafa Kamel", accountNumber: byName("Mohamed Mostafa Kamel").currentIban, bankCode: "0099", bankName: "Neo Bank (Demo)", isInternal: true, createdAt: at(days[60], 12) } }).catch(() => undefined);
  }

  // ---------- pending work queues (maker-checker) ----------
  const csC = staff["cs.cairo"];
  const pend = await createCustomer(csC, A(csC), { type: "INDIVIDUAL", nameAr: "يوسف شريف عبد الحميد", nameEn: "Youssef Sherif Abdelhamid", nationalId: "29912010112345", phone: "+201099887766", occupation: "Graphic Designer", monthlyIncome: "14000" });
  await createCustomer(staff["cs.giza"], A(staff["cs.giza"]), { type: "INDIVIDUAL", nameAr: "ليلى حسام الدين", nameEn: "Laila Hossam El-Din", nationalId: "29705150212345", phone: "+201288776655", occupation: "Pharmacist" });
  void pend;
  const kycToApprove = await createCustomer(staff["cs.alex"], A(staff["cs.alex"]), { type: "INDIVIDUAL", nameAr: "باسم عاطف ناجي", nameEn: "Bassem Atef Nagy", nationalId: "29203030312345", phone: "+201155443322", occupation: "Engineer" });
  const req = (await listApprovals(staff["mgr.alex"])).find((r) => r.entityId === kycToApprove.id);
  if (req) await decideApproval(staff["mgr.alex"], A(staff["mgr.alex"]), req.id, "APPROVE", "Documents verified in branch");
  // large cash withdrawal awaiting the branch manager
  const big = byName("Nile Supplies LLC");
  await cashWithdrawal(tc, A(tc), { accountId: big.current, amount: "650000.00", narrative: "Payroll cash", idempotencyKey: key("large") });
  // account freeze request (court order) awaiting approval
  await requestStatusChange(staff["mgr.cairo"], A(staff["mgr.cairo"]), byName("Karim Wael El-Banna").current, { status: "FROZEN", reason: "Court order no. 1234/2026 (fictional)" }).catch((e) => log("freeze request skipped:", (e as Error).message));
  // loans awaiting decision
  const officer = staff["credit.cairo"];
  const l1 = await applyLoan(officer, A(officer), { customerId: byName("Nourhan Samy Youssef").id, productId: products.PERSONAL, amount: "80000", termMonths: 24, accountId: byName("Nourhan Samy Youssef").current, purpose: "Home renovation" });
  const l2 = await applyLoan(officer, A(officer), { customerId: byName("Rehab Saeed Osman").id, productId: products.PERSONAL, amount: "35000", termMonths: 18, accountId: byName("Rehab Saeed Osman").current, purpose: "Education" });
  await loanDecision(officer, A(officer), l2.id, { action: "RECOMMEND" }).catch((e) => log("recommend skipped:", (e as Error).message));
  void l1;

  // ---------- support tickets ----------
  const T = [
    { who: "Ahmed Hassan Abdelaziz", subject: "استفسار عن رسوم السحب من صراف بنك آخر", category: "CARDS" as const, body: "تم خصم 5 جنيه عند السحب من ماكينة بنك آخر، هل هذا صحيح؟", reply: "نعم، رسوم السحب من شبكة البنوك الأخرى 5 جنيه للعملية وفق تعريفة البنك." },
    { who: "Mona Ali Ibrahim", subject: "Request for account certificate", category: "ACCOUNTS" as const, body: "I need a balance certificate for a visa application.", reply: "Your certificate is ready for pick-up at the Downtown branch." },
    { who: "Khaled Ibrahim El-Iskandarani", subject: "تفعيل الدفع الإلكتروني", category: "CARDS" as const, body: "كيف أفعل الدفع عبر الإنترنت لبطاقتي؟" },
    { who: "Ahmed Hassan Abdelaziz", subject: "Transfer delayed", category: "TRANSFERS" as const, body: "My transfer to another bank has not arrived yet." },
  ];
  for (const t of T) {
    const c = byName(t.who);
    const tk = await createTicket(c.id, c.def.en, { type: "CUSTOMER", id: c.id, name: c.def.en }, { subject: t.subject, category: t.category, body: t.body }, at(days[DAYS - 5], 11));
    if (t.reply) {
      const cs = staff[`cs.${c.branch === "0101" ? "cairo" : c.branch === "0201" ? "alex" : "giza"}`];
      await staffTicketAction(cs, A(cs), tk.id, { body: t.reply, status: "RESOLVED", assignToMe: true });
    }
  }

  const counts = {
    customers: await prisma.customer.count(), accounts: await prisma.account.count(), journalEntries: await prisma.journalEntry.count(), cardAuths: await prisma.cardAuthorization.count(),
    loans: await prisma.loan.count(), termDeposits: await prisma.termDeposit.count(), amlAlerts: await prisma.amlAlert.count(), eodRuns: await prisma.eodRun.count(), notifications: await prisma.notification.count(),
  };
  log("done in", ((Date.now() - t0) / 1000).toFixed(0), "s", counts);
  console.log(`\nDemo credentials\n  Staff (all roles) password: ${STAFF_PASSWORD}\n  Usernames: ${STAFF.map((s) => s.u).join(", ")}\n  Portal customers (password ${CUSTOMER_PASSWORD}): ${CUSTOMERS.filter((c) => c.portal).map((c) => c.portal).join(", ")}\n  Card PIN for seeded cards: ${CARD_PIN}\n`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
