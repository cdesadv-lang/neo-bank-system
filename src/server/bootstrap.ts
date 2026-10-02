import { PrismaClient } from "@prisma/client";
import { Tx } from "@/lib/db";
import { CHART_OF_ACCOUNTS } from "./gl";

type Db = Tx | PrismaClient;

/** Idempotently installs reference data required for the bank to operate. */
export async function ensureReferenceData(db: Db) {
  for (const g of CHART_OF_ACCOUNTS) {
    await db.glAccount.upsert({
      where: { code: g.code },
      update: { nameAr: g.nameAr, nameEn: g.nameEn },
      create: { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn, type: g.type, parentCode: g.parentCode ?? null, isControl: g.isControl ?? false, allowManualPosting: g.allowManualPosting ?? true },
    });
  }

  const fees = [
    { code: "EXT_TRANSFER", nameAr: "عمولة تحويل لبنك آخر", nameEn: "External transfer fee", event: "EXTERNAL_TRANSFER", fixedAmount: 0n, rateBps: 10, minAmount: 500n, maxAmount: 5000n },
    { code: "CASH_WD_OVER_LIMIT", nameAr: "عمولة سحب نقدي كبير", nameEn: "Large cash withdrawal fee", event: "CASH_WITHDRAWAL", fixedAmount: 0n, rateBps: 5, minAmount: 0n, maxAmount: 20000n },
    { code: "CARD_ISSUE", nameAr: "رسوم إصدار بطاقة افتراضية", nameEn: "Virtual card issuance fee", event: "CARD_ISSUANCE", fixedAmount: 2500n, rateBps: 0, minAmount: 0n, maxAmount: null },
    { code: "MONTHLY_MAINT", nameAr: "مصاريف إدارة حساب شهرية", nameEn: "Monthly account maintenance", event: "MONTHLY_MAINTENANCE", fixedAmount: 1000n, rateBps: 0, minAmount: 0n, maxAmount: null },
    { code: "ATM_NETWORK", nameAr: "رسوم سحب من صراف بنك آخر", nameEn: "Other-bank ATM withdrawal fee", event: "ATM_NETWORK_WITHDRAWAL", fixedAmount: 500n, rateBps: 0, minAmount: 0n, maxAmount: null },
    { code: "LOAN_ADMIN", nameAr: "مصاريف إدارية للقرض", nameEn: "Loan administration fee", event: "LOAN_DISBURSEMENT", fixedAmount: 0n, rateBps: 100, minAmount: 10000n, maxAmount: 500000n },
  ];
  for (const f of fees) {
    await db.feeRule.upsert({ where: { code: f.code }, update: {}, create: { ...f, currency: "EGP" } });
  }

  const rules = [
    { code: "CASH_CTR", nameAr: "إيداع/سحب نقدي كبير", nameEn: "Large cash transaction (CTR)", kind: "CASH_AMOUNT", threshold: 50000000n, windowMinutes: 0, severity: "HIGH" },
    { code: "SINGLE_LARGE", nameAr: "حركة فردية كبيرة", nameEn: "Large single movement", kind: "SINGLE_AMOUNT", threshold: 100000000n, windowMinutes: 0, severity: "MEDIUM" },
    { code: "VELOCITY_COUNT_1H", nameAr: "عدد حركات مرتفع خلال ساعة", nameEn: "High transaction count in 1 hour", kind: "VELOCITY_COUNT", threshold: 10n, windowMinutes: 60, severity: "MEDIUM" },
    { code: "VELOCITY_AMT_24H", nameAr: "مبالغ مرتفعة خلال 24 ساعة", nameEn: "High cumulative amount in 24h", kind: "VELOCITY_AMOUNT", threshold: 150000000n, windowMinutes: 1440, severity: "HIGH" },
    { code: "HIGH_RISK", nameAr: "حركة لعميل عالي المخاطر", nameEn: "High-risk customer movement", kind: "HIGH_RISK_CUSTOMER", threshold: 10000000n, windowMinutes: 0, severity: "HIGH" },
  ];
  for (const r of rules) {
    await db.amlRule.upsert({ where: { code: r.code }, update: {}, create: r });
  }

  const products = [
    { code: "PERSONAL", nameAr: "قرض شخصي", nameEn: "Personal Loan", annualRateBps: 2400, penaltyRateBps: 3600, feeBps: 100, minAmount: 1000000n, maxAmount: 100000000n, minTermMonths: 6, maxTermMonths: 60 },
    { code: "AUTO", nameAr: "قرض سيارة", nameEn: "Auto Loan", annualRateBps: 2100, penaltyRateBps: 3000, feeBps: 100, minAmount: 5000000n, maxAmount: 300000000n, minTermMonths: 12, maxTermMonths: 84 },
    { code: "SME", nameAr: "تمويل مشروعات صغيرة", nameEn: "SME Working Capital", annualRateBps: 1900, penaltyRateBps: 2800, feeBps: 150, minAmount: 10000000n, maxAmount: 1000000000n, minTermMonths: 6, maxTermMonths: 36 },
  ];
  for (const p of products) {
    await db.loanProduct.upsert({ where: { code: p.code }, update: {}, create: { ...p, currency: "EGP" } });
  }
}
