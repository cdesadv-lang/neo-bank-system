import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { dashboard } from "@/server/services/reports";
import { PageTitle, Stat, Grid, Card, money, Notice, Table } from "@/components/ui";
import { BarChart, Donut } from "@/components/charts";
import { minorToString } from "@/lib/money";

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const { staff, lang } = await requireStaffPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  if (!can(staff, "dashboard.read")) return <Notice>{t("ليس لديك صلاحية عرض لوحة التحكم.", "You don't have dashboard access.")}</Notice>;
  const d = await dashboard(staff);
  const colors = ["#0369a1", "#059669", "#d97706", "#7c3aed", "#e11d48"];
  return (
    <div className="space-y-5">
      <PageTitle title={t("لوحة التحكم", "Dashboard")} subtitle={staff.branchId ? t("بيانات الفرع فقط", "Branch-scoped view") : t("كل الفروع", "All branches")} />
      {sp.denied && <Notice tone="rose">{t("ليس لديك صلاحية:", "Permission denied:")} <span dir="ltr">{sp.denied}</span></Notice>}
      <Grid>
        <Stat label={t("العملاء", "Customers")} value={d.customers} hint={`${t("بانتظار KYC", "Pending KYC")}: ${d.pendingKyc}`} />
        <Stat label={t("الحسابات", "Accounts")} value={d.accounts} />
        <Stat label={t("إجمالي الودائع (بما يعادل ج.م)", "Total deposits (EGP eq.)")} value={money(d.depositsEgpEq)} tone="green" />
        <Stat label={t("محفظة القروض", "Loan portfolio")} value={money(d.loanOutstanding)} hint={`NPL ${(d.nplRatioBps / 100).toFixed(2)}%`} tone={d.nplRatioBps > 500 ? "red" : "blue"} />
        <Stat label={t("موافقات معلقة", "Pending approvals")} value={d.approvals} tone={d.approvals ? "amber" : "slate"} />
        <Stat label={t("تنبيهات AML مفتوحة", "Open AML alerts")} value={d.openAlerts} tone={d.openAlerts ? "red" : "slate"} />
        <Stat label={t("شكاوى مفتوحة", "Open tickets")} value={d.openTickets} />
      </Grid>
      <Grid cols={2}>
        <Card title={t("حجم العمليات اليومي (ج.م) — آخر 30 يوماً", "Daily transaction volume (EGP) — last 30 days")}>
          <BarChart data={d.daily.map((x) => ({ x: x.date, y: Number(x.volume) / 100 }))} label={(v) => v.toLocaleString("en")} />
        </Card>
        <Card title={t("عدد القيود اليومية", "Daily journal count")}>
          <BarChart data={d.daily.map((x) => ({ x: x.date, y: x.count }))} color="#059669" />
        </Card>
        <Card title={t("الودائع حسب العملة والنوع", "Deposits by currency and type")}>
          <Table rows={d.depositSums} cols={[{ h: t("العملة", "Currency"), c: (r) => r.currency }, { h: t("النوع", "Type"), c: (r) => r.type }, { h: t("الرصيد", "Balance"), c: (r) => <span dir="ltr">{money(r._sum.balance ?? 0n, r.currency)}</span> }]} />
        </Card>
        <Card title={t("تصنيف القروض", "Loan classification")}>
          <Donut parts={d.loans.map((l, i) => ({ label: `${l.classification} (${l._count})`, value: Number(minorToString(l._sum.outstandingPrincipal ?? 0n)), color: colors[i % colors.length] }))} />
        </Card>
      </Grid>
    </div>
  );
}
