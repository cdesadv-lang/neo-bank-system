import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Grid, Notice } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { CashOpForm, BalanceTillForm } from "@/components/teller";
import { deviceOptions, countLabels } from "@/server/page-data";
import { LARGE_CASH_THRESHOLD } from "@/server/services/teller";

export default async function Teller() {
  const { staff, lang } = await requireStaffPage("cash.deposit");
  const t = (a: string, e: string) => tr(lang, a, e);
  const tills = await prisma.till.findMany({ where: { assignedToId: staff.id }, orderBy: { currency: "asc" } });
  const devices = await deviceOptions(staff);
  const L = countLabels(t);
  const recent = await prisma.journalEntry.findMany({ where: { createdByStaffId: staff.id, type: { in: ["CASH_DEPOSIT", "CASH_WITHDRAWAL"] } }, orderBy: { postedAt: "desc" }, take: 15 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("شاشة الصراف", "Teller")} subtitle={t(`السحب النقدي من ${money(LARGE_CASH_THRESHOLD)} فأكثر يتطلب موافقة مدير الفرع`, `Cash withdrawals ≥ ${money(LARGE_CASH_THRESHOLD)} need branch-manager approval`)} />
      <Card title={t("خزائني", "My tills")}>
        {tills.length === 0 ? <Notice>{t("لا توجد خزينة مخصصة لك. اطلب من مدير الفرع تخصيص خزينة.", "No till assigned. Ask your branch manager to assign one.")}</Notice> :
          <Table rows={tills} cols={[
            { h: t("الخزينة", "Till"), c: (x) => <Ltr>{x.code}</Ltr> }, { h: t("العملة", "CCY"), c: (x) => x.currency },
            { h: t("الرصيد الدفتري", "Book balance"), c: (x) => <Ltr>{money(x.balance, x.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> },
            { h: "", c: (x) => x.status !== "OPEN" ? <ActionButton endpoint="/api/staff/tills" body={{ action: "OPEN", tillId: x.id }} label={t("فتح الخزينة", "Open till")} /> : null },
          ]} />}
      </Card>
      <Grid cols={2}>
        <Card title={t("إيداع نقدي", "Cash deposit")}><CashOpForm kind="deposit" devices={devices} t={L} /></Card>
        {can(staff, "cash.withdraw") && <Card title={t("سحب نقدي", "Cash withdrawal")}><CashOpForm kind="withdraw" devices={devices} t={L} /></Card>}
      </Grid>
      {tills.filter((x) => x.status === "OPEN").map((x) => (
        <Card key={x.id} title={`${t("موازنة نهاية اليوم", "End-of-day balancing")} — ${x.code}`}>
          <BalanceTillForm tillId={x.id} devices={devices} t={L} />
        </Card>
      ))}
      <Card title={t("آخر عملياتي", "My recent operations")}>
        <Table rows={recent} cols={[{ h: t("القيد", "Entry"), c: (e) => <Ltr>{e.entryNo}</Ltr> }, { h: t("النوع", "Type"), c: (e) => e.type }, { h: t("البيان", "Description"), c: (e) => e.description }, { h: t("الوقت", "Time"), c: (e) => dt(e.postedAt) }, { h: "", c: (e) => <Badge v={e.status} lang={lang} /> }]} />
      </Card>
    </div>
  );
}
