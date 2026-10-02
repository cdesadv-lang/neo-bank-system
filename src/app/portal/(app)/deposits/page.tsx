import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { myAccounts } from "@/server/services/portal";
import { TD_RATES, TD_MIN } from "@/server/services/deposits";
import { PageTitle, Card, Table, Badge, Ltr, money } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function PortalDeposits() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const deps = await prisma.termDeposit.findMany({ where: { account: { customerId: customer.customerId } }, include: { account: true }, orderBy: { createdAt: "desc" } });
  const accounts = (await myAccounts(customer.customerId)).filter((a) => a.type !== "TERM_DEPOSIT" && a.status === "ACTIVE");
  return (
    <div className="space-y-5">
      <PageTitle title={t("الودائع لأجل", "Term deposits")} />
      <Card>
        <Table rows={deps} empty={t("لا توجد ودائع", "No deposits")} cols={[{ h: t("الحساب", "Account"), c: (d) => <Ltr>{d.account.accountNumber}</Ltr> }, { h: t("الأصل", "Principal"), c: (d) => <Ltr>{money(d.principal, d.account.currency)}</Ltr> }, { h: t("الرصيد", "Balance"), c: (d) => <Ltr>{money(d.account.balance, d.account.currency)}</Ltr> }, { h: t("العائد", "Rate"), c: (d) => `${d.rateBps / 100}%` }, { h: t("الاستحقاق", "Maturity"), c: (d) => <Ltr>{d.maturityDate.toISOString().slice(0, 10)}</Ltr> }, { h: "", c: (d) => <Badge v={d.status} lang={lang} /> }]} />
      </Card>
      <Card title={t("الأسعار", "Rates")}>
        <Table rows={Object.entries(TD_RATES)} cols={[{ h: t("العملة", "CCY"), c: ([c]) => <span>{c} <span className="text-xs text-slate-500">min {money(TD_MIN[c as keyof typeof TD_MIN], "")}</span></span> }, ...[3, 6, 12, 24, 36].map((m) => ({ h: `${m}m`, c: ([, v]: [string, Record<number, number>]) => `${(v[m] ?? 0) / 100}%` }))]} />
      </Card>
      {customer.kycStatus === "APPROVED" && (
        <Card title={t("فتح وديعة", "Open a deposit")}>
          <ApiForm idempotent endpoint="/api/portal/deposits" submitLabel={t("فتح", "Open")} fields={[
            { name: "sourceAccountId", label: t("من حساب", "From account"), type: "select", options: accounts.map((a) => ({ value: a.id, label: `${a.accountNumber} · ${money(a.balance, a.currency)}` })) },
            { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true },
            { name: "termMonths", label: t("المدة", "Term"), type: "select", options: [3, 6, 12, 24, 36].map((m) => ({ value: String(m), label: `${m} ${t("شهر", "months")}` })) },
            { name: "interestPayout", label: t("العائد", "Interest"), type: "select", options: [{ value: "CAPITALIZE", label: t("يضاف للوديعة", "Capitalize") }, { value: "PAYOUT", label: t("يصرف شهرياً للحساب", "Pay monthly to account") }] }]} />
        </Card>
      )}
    </div>
  );
}
