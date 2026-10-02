import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, A, Notice } from "@/components/ui";
import { ActionButton } from "@/components/client";

export default async function Cards({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { staff, lang } = await requireStaffPage("card.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const cards = await prisma.card.findMany({
    where: { account: branchWhere(staff), ...(sp.q ? { OR: [{ last4: { contains: sp.q } }, { customer: { nameEn: { contains: sp.q, mode: "insensitive" } } }, { customer: { cif: { contains: sp.q.toUpperCase() } } }] } : {}) },
    include: { customer: true, account: true }, orderBy: { createdAt: "desc" }, take: 200, omit: { token: true, pinVerificationValue: true },
  });
  const on = (b: boolean) => (b ? "✓" : "✗");
  return (
    <div className="space-y-5">
      <PageTitle title={t("البطاقات", "Cards")} subtitle={t("بطاقات خصم افتراضية — BIN وهمي 999999، لا يتم تخزين أرقام بطاقات حقيقية", "Virtual debit cards — fictional BIN 999999, no real PANs stored")} />
      <Notice tone="sky">{t("الإصدار من صفحة العميل. إلغاء الإيقاف يتطلب موافقة موظف آخر.", "Issue from the customer page. Unblocking requires a second-person approval.")}</Notice>
      <Card>
        <form className="mb-3 flex gap-2 text-sm"><input name="q" defaultValue={sp.q} placeholder={t("آخر 4 أرقام / اسم / CIF", "last 4 / name / CIF")} className="rounded border border-slate-300 px-2 py-1.5" /><button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("بحث", "Search")}</button></form>
        <Table rows={cards} cols={[
          { h: t("البطاقة", "Card"), c: (c) => <A href={`/staff/card-auths?cardId=${c.id}`}><Ltr>{c.maskedPan}</Ltr></A> }, { h: t("العميل", "Customer"), c: (c) => <A href={`/staff/customers/${c.customerId}`}>{tr(lang, c.customer.nameAr, c.customer.nameEn)}</A> },
          { h: t("الحساب", "Account"), c: (c) => <Ltr>{c.account.accountNumber.slice(-8)} {c.account.currency}</Ltr> }, { h: t("الانتهاء", "Expiry"), c: (c) => <Ltr>{String(c.expiryMonth).padStart(2, "0")}/{c.expiryYear}</Ltr> },
          { h: "ATM/POS/ECOM/NFC/INTL", c: (c) => <Ltr>{[c.atmEnabled, c.posEnabled, c.onlineEnabled, c.contactlessEnabled, c.internationalEnabled].map(on).join(" ")}</Ltr> },
          { h: t("الحد اليومي", "Daily limit"), c: (c) => <Ltr>{money(c.dailyLimit)}</Ltr> }, { h: t("الحالة", "Status"), c: (c) => <span><Badge v={c.status} lang={lang} />{c.blockReason && <span className="ms-1 text-xs text-slate-500">{c.blockReason}</span>}</span> },
          { h: "", c: (c) => can(staff, "card.manage") ? (
            <div className="flex gap-1">
              {c.status !== "BLOCKED" && c.status !== "CANCELLED" && <ActionButton tone="danger" endpoint={`/api/staff/cards/${c.id}`} body={{ action: "BLOCK" }} prompt={{ field: "reason", label: t("سبب الإيقاف", "Block reason") }} label={t("إيقاف", "Block")} />}
              {c.status === "BLOCKED" && <ActionButton endpoint={`/api/staff/cards/${c.id}`} body={{ action: "REQUEST_UNBLOCK" }} prompt={{ field: "reason", label: t("السبب", "Reason") }} label={t("طلب فك الإيقاف", "Request unblock")} />}
            </div>) : null },
        ]} />
      </Card>
    </div>
  );
}
