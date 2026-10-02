import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { myAccounts } from "@/server/services/portal";
import { PageTitle, Card, Table, Badge, Ltr, money } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function PortalLoans() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const loans = await prisma.loan.findMany({ where: { customerId: customer.customerId }, include: { product: true, installments: { orderBy: { seq: "asc" } } }, orderBy: { createdAt: "desc" } });
  const products = await prisma.loanProduct.findMany({ where: { active: true } });
  const accounts = (await myAccounts(customer.customerId)).filter((a) => a.type === "CURRENT" && a.status === "ACTIVE");
  return (
    <div className="space-y-5">
      <PageTitle title={t("القروض", "Loans")} />
      {loans.map((l) => {
        const next = l.installments.find((i) => i.status !== "PAID");
        return (
          <Card key={l.id} title={`${tr(lang, l.product.nameAr, l.product.nameEn)} — ${l.loanNumber}`} actions={<Badge v={l.status} lang={lang} />}>
            <p className="mb-2 text-sm">{t("الأصل", "Principal")} <Ltr>{money(l.principal, l.currency)}</Ltr> · {t("القائم", "Outstanding")} <Ltr>{money(l.outstandingPrincipal, l.currency)}</Ltr> · {l.annualRateBps / 100}% · {l.termMonths} {t("شهر", "months")}{l.daysPastDue > 0 && <span className="ms-2 font-bold text-rose-700">{t("متأخر", "Overdue")} {l.daysPastDue} {t("يوم", "days")}</span>}</p>
            {next && <p className="mb-2 text-sm">{t("القسط القادم", "Next instalment")}: <Ltr>{next.dueDate.toISOString().slice(0, 10)} · {money(next.principalDue + next.interestDue + next.penaltyDue - next.principalPaid - next.interestPaid - next.penaltyPaid, l.currency)}</Ltr></p>}
            <details><summary className="cursor-pointer text-sm text-sky-700">{t("جدول السداد", "Schedule")}</summary>
              <Table rows={l.installments} cols={[{ h: "#", c: (i) => i.seq }, { h: t("الاستحقاق", "Due"), c: (i) => <Ltr>{i.dueDate.toISOString().slice(0, 10)}</Ltr> }, { h: t("القسط", "Amount"), c: (i) => <Ltr>{money(i.principalDue + i.interestDue, "")}</Ltr> }, { h: t("الحالة", "Status"), c: (i) => <Badge v={i.status} lang={lang} /> }]} />
            </details>
          </Card>
        );
      })}
      {customer.kycStatus === "APPROVED" && accounts.length > 0 && (
        <Card title={t("طلب قرض جديد", "Apply for a loan")}>
          <ApiForm endpoint="/api/portal/loans" submitLabel={t("تقديم الطلب", "Submit application")} fields={[
            { name: "productId", label: t("المنتج", "Product"), type: "select", options: products.map((p) => ({ value: p.id, label: `${tr(lang, p.nameAr, p.nameEn)} · ${p.annualRateBps / 100}%` })) },
            { name: "accountId", label: t("حساب الصرف والسداد", "Disbursement / repayment account"), type: "select", options: accounts.map((a) => ({ value: a.id, label: `${a.accountNumber} · ${a.currency}` })) },
            { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true }, { name: "termMonths", label: t("المدة (شهور)", "Term (months)"), type: "number", required: true, defaultValue: "24" },
            { name: "purpose", label: t("الغرض", "Purpose"), wide: true }]} />
        </Card>
      )}
    </div>
  );
}
