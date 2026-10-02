import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { listLoans } from "@/server/services/loans";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, A } from "@/components/ui";

export default async function Loans({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { staff, lang } = await requireStaffPage("loan.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const loans = await listLoans(staff, { status: sp.status || undefined });
  const products = await prisma.loanProduct.findMany();
  return (
    <div className="space-y-5">
      <PageTitle title={t("القروض", "Loans")} subtitle={t("طلب القرض من صفحة العميل. سير العمل: مقدم ← موصى به (مسؤول ائتمان) ← معتمد (مدير ائتمان، شخص مختلف) ← منصرف", "Apply from the customer page. Workflow: APPLIED → RECOMMENDED (credit officer) → APPROVED (credit manager, different person) → DISBURSED")} />
      <Card>
        <form className="mb-3 flex gap-2 text-sm"><select name="status" defaultValue={sp.status ?? ""} className="rounded border border-slate-300 px-2 py-1.5"><option value="">{t("الكل", "All")}</option>{["APPLIED", "RECOMMENDED", "APPROVED", "DISBURSED", "CLOSED", "REJECTED"].map((s) => <option key={s}>{s}</option>)}</select><button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("تصفية", "Filter")}</button></form>
        <Table rows={loans} cols={[
          { h: "#", c: (l) => <A href={`/staff/loans/${l.id}`}><Ltr>{l.loanNumber}</Ltr></A> }, { h: t("العميل", "Customer"), c: (l) => tr(lang, l.customer.nameAr, l.customer.nameEn) },
          { h: t("المنتج", "Product"), c: (l) => tr(lang, l.product.nameAr, l.product.nameEn) }, { h: t("الأصل", "Principal"), c: (l) => <Ltr>{money(l.principal, l.currency)}</Ltr> },
          { h: t("القائم", "Outstanding"), c: (l) => <Ltr>{money(l.outstandingPrincipal, l.currency)}</Ltr> }, { h: t("العائد", "Rate"), c: (l) => `${l.annualRateBps / 100}%` },
          { h: t("المدة", "Term"), c: (l) => l.termMonths }, { h: "DPD", c: (l) => l.daysPastDue }, { h: t("التصنيف", "Class"), c: (l) => l.classification }, { h: t("الحالة", "Status"), c: (l) => <Badge v={l.status} lang={lang} /> },
        ]} />
      </Card>
      <Card title={t("منتجات القروض", "Loan products")}>
        <Table rows={products} cols={[{ h: t("المنتج", "Product"), c: (p) => tr(lang, p.nameAr, p.nameEn) }, { h: t("العائد", "Rate"), c: (p) => `${p.annualRateBps / 100}%` }, { h: t("غرامة", "Penalty"), c: (p) => `${p.penaltyRateBps / 100}%` }, { h: t("رسوم", "Fee"), c: (p) => `${p.feeBps / 100}%` }, { h: t("الحدود", "Limits"), c: (p) => <Ltr>{money(p.minAmount, p.currency)} – {money(p.maxAmount, p.currency)}</Ltr> }, { h: t("المدة", "Term"), c: (p) => `${p.minTermMonths}–${p.maxTermMonths}` }]} />
      </Card>
    </div>
  );
}
