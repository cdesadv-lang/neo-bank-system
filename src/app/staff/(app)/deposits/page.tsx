import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { depositsReport } from "@/server/services/reports";
import { TD_RATES } from "@/server/services/deposits";
import { requirePerm } from "@/server/rbac";
import { PageTitle, Card, Table, Badge, Ltr, money, A } from "@/components/ui";

export default async function Deposits() {
  const { staff, lang } = await requireStaffPage("account.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  let r: Awaited<ReturnType<typeof depositsReport>> | null = null;
  try { requirePerm(staff, "report.read"); r = await depositsReport(staff); } catch { r = null; }
  return (
    <div className="space-y-5">
      <PageTitle title={t("الودائع", "Deposits")} subtitle={t("فتح الودائع من صفحة العميل. العائد يحتسب يومياً (Actual/365) في إقفال اليوم.", "Open deposits from the customer page. Interest accrues daily (Actual/365) in EOD.")} />
      <Card title={t("أسعار الودائع لأجل", "Term-deposit rates")}>
        <Table rows={Object.entries(TD_RATES)} cols={[{ h: t("العملة", "CCY"), c: ([c]) => c }, ...[3, 6, 12, 24, 36].map((m) => ({ h: `${m}m`, c: ([, v]: [string, Record<number, number>]) => `${(v[m] ?? 0) / 100}%` }))]} />
      </Card>
      {r && <>
        <Card title={t("أرصدة الودائع", "Deposit balances")}>
          <Table rows={r.sums} cols={[{ h: t("النوع", "Type"), c: (s) => s.type }, { h: t("العملة", "CCY"), c: (s) => s.currency }, { h: t("عدد", "Count"), c: (s) => s._count }, { h: t("الرصيد", "Balance"), c: (s) => <Ltr>{money(s._sum.balance ?? 0n, s.currency)}</Ltr> }]} />
        </Card>
        <Card title={t("الودائع لأجل القائمة", "Active term deposits")}>
          <Table rows={r.tds} cols={[
            { h: t("الحساب", "Account"), c: (d) => <A href={`/staff/accounts/${d.accountId}`}><Ltr>{d.account.accountNumber}</Ltr></A> }, { h: t("العميل", "Customer"), c: (d) => tr(lang, d.account.customer.nameAr, d.account.customer.nameEn) },
            { h: t("الأصل", "Principal"), c: (d) => <Ltr>{money(d.principal, d.account.currency)}</Ltr> }, { h: t("العائد", "Rate"), c: (d) => `${d.rateBps / 100}%` },
            { h: t("الاستحقاق", "Maturity"), c: (d) => <Ltr>{d.maturityDate.toISOString().slice(0, 10)}</Ltr> }, { h: t("العائد", "Payout"), c: (d) => d.interestPayout }, { h: "", c: (d) => <Badge v={d.status} lang={lang} /> },
          ]} />
        </Card>
      </>}
    </div>
  );
}
