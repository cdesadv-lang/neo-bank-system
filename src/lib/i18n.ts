export type Lang = "ar" | "en";
export const LANG_COOKIE = "lang";

/** Tiny bilingual helper: pick the Arabic or English string. */
export function tr(lang: Lang, ar: string, en: string): string {
  return lang === "ar" ? ar : en;
}

export const NAV_STAFF: { href: string; ar: string; en: string; perm?: string }[] = [
  { href: "/staff", ar: "لوحة التحكم", en: "Dashboard", perm: "dashboard.read" },
  { href: "/staff/customers", ar: "العملاء و KYC", en: "Customers & KYC", perm: "customer.read" },
  { href: "/staff/accounts", ar: "الحسابات", en: "Accounts", perm: "account.read" },
  { href: "/staff/teller", ar: "الصراف (الكاونتر)", en: "Teller", perm: "cash.deposit" },
  { href: "/staff/tills", ar: "الخزائن والخزينة الرئيسية", en: "Tills & Vault", perm: "till.read" },
  { href: "/staff/devices", ar: "ماكينات عد النقدية", en: "Cash counters", perm: "till.read" },
  { href: "/staff/transfers", ar: "التحويلات والمقاصة", en: "Transfers & clearing", perm: "account.read" },
  { href: "/staff/loans", ar: "القروض", en: "Loans", perm: "loan.read" },
  { href: "/staff/deposits", ar: "الودائع", en: "Deposits", perm: "account.read" },
  { href: "/staff/cards", ar: "البطاقات", en: "Cards", perm: "card.read" },
  { href: "/staff/card-auths", ar: "عمليات البطاقات", en: "Card transactions", perm: "card.read" },
  { href: "/staff/disputes", ar: "الاعتراضات", en: "Disputes", perm: "card.read" },
  { href: "/staff/atms", ar: "أجهزة الصراف الآلي", en: "ATMs", perm: "atm.read" },
  { href: "/staff/aml", ar: "مكافحة غسل الأموال", en: "AML", perm: "aml.read" },
  { href: "/staff/approvals", ar: "الموافقات", en: "Approvals", perm: "approval.read" },
  { href: "/staff/journals", ar: "القيود ودفتر الأستاذ", en: "Journals & GL", perm: "journal.read" },
  { href: "/staff/reports", ar: "التقارير", en: "Reports", perm: "report.read" },
  { href: "/staff/eod", ar: "إقفال نهاية اليوم", en: "End of day", perm: "eod.run" },
  { href: "/staff/tickets", ar: "الشكاوى والطلبات", en: "Tickets (CRM)", perm: "ticket.read" },
  { href: "/staff/admin", ar: "الموظفون والفروع", en: "Staff & branches", perm: "staff.read" },
  { href: "/staff/audit", ar: "سجل التدقيق", en: "Audit log", perm: "audit.read" },
  { href: "/staff/security", ar: "الأمان (كلمة المرور / 2FA)", en: "Security (password / 2FA)" },
];

export const NAV_PORTAL: { href: string; ar: string; en: string }[] = [
  { href: "/portal", ar: "حساباتي", en: "My accounts" },
  { href: "/portal/transfers", ar: "التحويلات", en: "Transfers" },
  { href: "/portal/beneficiaries", ar: "المستفيدون", en: "Beneficiaries" },
  { href: "/portal/bills", ar: "دفع الفواتير", en: "Bill payments" },
  { href: "/portal/cards", ar: "البطاقات", en: "Cards" },
  { href: "/portal/loans", ar: "القروض", en: "Loans" },
  { href: "/portal/deposits", ar: "الودائع", en: "Deposits" },
  { href: "/portal/notifications", ar: "الإشعارات", en: "Notifications" },
  { href: "/portal/tickets", ar: "الدعم", en: "Support" },
  { href: "/portal/profile", ar: "الملف والأمان", en: "Profile & security" },
];

/** Labels for enum values shown in tables. */
export const STATUS_AR: Record<string, string> = {
  ACTIVE: "نشط", FROZEN: "مجمّد", DORMANT: "راكد", CLOSED: "مغلق", PENDING: "قيد المراجعة", APPROVED: "معتمد", REJECTED: "مرفوض",
  POSTED: "مرحّل", REVERSED: "معكوس", COMPLETED: "مكتمل", FAILED: "فشل", AUTHORIZED: "محجوز", CAPTURED: "تمت التسوية", RELEASED: "تم الفك",
  DECLINED: "مرفوض", REFUNDED: "مسترد", PARTIALLY_REFUNDED: "مسترد جزئياً", PENDING_3DS: "بانتظار 3DS", BLOCKED: "موقوف", OPEN: "مفتوح",
  ONLINE: "متصل", OFFLINE: "غير متصل", DISBURSED: "منصرف", APPLIED: "مقدم", RECOMMENDED: "موصى به", SUBMITTED: "مرسل", SETTLED: "مسوّى",
  IN_PROGRESS: "قيد التنفيذ", RESOLVED: "تم الحل", CHARGEBACK_RAISED: "استرداد مؤقت", RESOLVED_CUSTOMER: "لصالح العميل", RESOLVED_MERCHANT: "لصالح التاجر",
  PROCESSING: "قيد المعالجة", MATURED: "مستحقة", CANCELLED: "ملغاة", IN_REVIEW: "قيد الفحص", ESCALATED: "مُصعّد", CLOSED_FALSE_POSITIVE: "إنذار كاذب",
};
