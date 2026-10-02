import type { GlType } from "@prisma/client";

/** Chart of accounts (codes are stable identifiers used by the posting engine). */
export const GL = {
  CASH_VAULT: "1010",
  CASH_TILLS: "1020",
  DUE_FROM_CBE: "1100", // settlement account at the central bank (nostro)
  LOANS: "1300",
  CURRENT_ACCOUNTS: "2010",
  SAVINGS_ACCOUNTS: "2020",
  TERM_DEPOSITS: "2030",
  CLEARING_OUTGOING: "2100",
  INTEREST_PAYABLE: "2200",
  BILLS_PAYABLE: "2300",
  CAPITAL: "3010",
  RETAINED_EARNINGS: "3020",
  LOAN_INTEREST_INCOME: "4010",
  FEE_INCOME: "4020",
  PENALTY_INCOME: "4030",
  DEPOSIT_INTEREST_EXPENSE: "5010",
  CASH_OVER_SHORT: "5020",
} as const;

export const CHART_OF_ACCOUNTS: {
  code: string; nameAr: string; nameEn: string; type: GlType; parentCode?: string; isControl?: boolean; allowManualPosting?: boolean;
}[] = [
  { code: "1000", nameAr: "الأصول", nameEn: "Assets", type: "ASSET", allowManualPosting: false },
  { code: "1010", nameAr: "النقدية بالخزينة الرئيسية", nameEn: "Cash in Vault", type: "ASSET", parentCode: "1000", isControl: true, allowManualPosting: false },
  { code: "1020", nameAr: "النقدية بخزائن الصرافين", nameEn: "Cash at Teller Tills", type: "ASSET", parentCode: "1000", isControl: true, allowManualPosting: false },
  { code: "1100", nameAr: "أرصدة لدى البنك المركزي", nameEn: "Due from Central Bank (Settlement)", type: "ASSET", parentCode: "1000" },
  { code: "1300", nameAr: "قروض العملاء", nameEn: "Loans to Customers", type: "ASSET", parentCode: "1000", isControl: true, allowManualPosting: false },
  { code: "2000", nameAr: "الالتزامات", nameEn: "Liabilities", type: "LIABILITY", allowManualPosting: false },
  { code: "2010", nameAr: "الحسابات الجارية للعملاء", nameEn: "Customer Current Accounts", type: "LIABILITY", parentCode: "2000", isControl: true, allowManualPosting: false },
  { code: "2020", nameAr: "حسابات التوفير", nameEn: "Customer Savings Accounts", type: "LIABILITY", parentCode: "2000", isControl: true, allowManualPosting: false },
  { code: "2030", nameAr: "الودائع لأجل", nameEn: "Customer Term Deposits", type: "LIABILITY", parentCode: "2000", isControl: true, allowManualPosting: false },
  { code: "2100", nameAr: "تسويات المقاصة الصادرة", nameEn: "Outgoing Clearing Suspense", type: "LIABILITY", parentCode: "2000" },
  { code: "2200", nameAr: "فوائد مستحقة الدفع", nameEn: "Accrued Interest Payable", type: "LIABILITY", parentCode: "2000" },
  { code: "2300", nameAr: "مدفوعات فواتير مستحقة للجهات", nameEn: "Bill Payments Payable", type: "LIABILITY", parentCode: "2000" },
  { code: "3000", nameAr: "حقوق الملكية", nameEn: "Equity", type: "EQUITY", allowManualPosting: false },
  { code: "3010", nameAr: "رأس المال المدفوع", nameEn: "Paid-in Capital", type: "EQUITY", parentCode: "3000" },
  { code: "3020", nameAr: "الأرباح المحتجزة", nameEn: "Retained Earnings", type: "EQUITY", parentCode: "3000" },
  { code: "4000", nameAr: "الإيرادات", nameEn: "Income", type: "INCOME", allowManualPosting: false },
  { code: "4010", nameAr: "عوائد القروض", nameEn: "Loan Interest Income", type: "INCOME", parentCode: "4000" },
  { code: "4020", nameAr: "إيرادات العمولات والرسوم", nameEn: "Fee & Commission Income", type: "INCOME", parentCode: "4000" },
  { code: "4030", nameAr: "غرامات التأخير", nameEn: "Penalty Income", type: "INCOME", parentCode: "4000" },
  { code: "5000", nameAr: "المصروفات", nameEn: "Expenses", type: "EXPENSE", allowManualPosting: false },
  { code: "5010", nameAr: "عوائد الودائع المدفوعة", nameEn: "Interest Expense on Deposits", type: "EXPENSE", parentCode: "5000" },
  { code: "5020", nameAr: "عجز وزيادة النقدية", nameEn: "Cash Over / Short", type: "EXPENSE", parentCode: "5000" },
];

export function glForAccountType(t: "CURRENT" | "SAVINGS" | "TERM_DEPOSIT"): string {
  return t === "CURRENT" ? GL.CURRENT_ACCOUNTS : t === "SAVINGS" ? GL.SAVINGS_ACCOUNTS : GL.TERM_DEPOSITS;
}

/** Normal balance side: assets/expenses are debit-normal, the rest credit-normal. */
export function isDebitNormal(t: GlType): boolean {
  return t === "ASSET" || t === "EXPENSE";
}
