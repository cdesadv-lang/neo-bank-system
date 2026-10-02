import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { getAccount, accountStatement } from "@/server/services/accounts";
import { PageTitle, Card, Badge, A, Ltr, money, Grid, Stat } from "@/components/ui";
import { ApiForm } from "@/components/client";
import { StatementView } from "@/components/statement";
import { formatIban } from "@/lib/iban";

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { staff, lang } = await requireStaffPage("account.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const { id } = await params;
  const sp = await searchParams;
  const a = await getAccount(staff, id);
  const s = await accountStatement(id, sp.from ? new Date(sp.from) : undefined, sp.to ? new Date(sp.to + "T23:59:59Z") : undefined);
  return (
    <div className="space-y-5">
      <PageTitle title={formatIban(a.accountNumber)} subtitle={`${a.type} · ${a.currency} · ${tr(lang, a.branch.nameAr, a.branch.nameEn)}`} actions={<Badge v={a.status} lang={lang} />} />
      <Grid>
        <Stat label={t("الرصيد", "Balance")} value={money(a.balance, a.currency)} tone="green" />
        <Stat label={t("العميل", "Customer")} value={<A href={`/staff/customers/${a.customerId}`}>{tr(lang, a.customer.nameAr, a.customer.nameEn)}</A>} />
        <Stat label={t("عائد مستحق غير مرحل", "Accrued interest")} value={a.accruedInterest.toFixed(2)} />
        <Stat label={t("سعر العائد", "Interest rate")} value={`${a.interestRateBps / 100}%`} />
      </Grid>
      {a.termDeposit && <Card title={t("وديعة لأجل", "Term deposit")}><p className="text-sm"><Ltr>{money(a.termDeposit.principal, a.currency)}</Ltr> · {a.termDeposit.rateBps / 100}% · {a.termDeposit.termMonths} {t("شهر", "months")} · {t("الاستحقاق", "Maturity")} <Ltr>{a.termDeposit.maturityDate.toISOString().slice(0, 10)}</Ltr> · <Badge v={a.termDeposit.status} lang={lang} /></p></Card>}
      {can(staff, "account.status") && (
        <Card title={t("تغيير الحالة (يتطلب موافقة موظف آخر)", "Change status (requires a second approver)")}>
          <ApiForm compact endpoint={`/api/staff/accounts/${a.id}/status`} submitLabel={t("طلب", "Request")} fields={[
            { name: "status", label: t("الحالة الجديدة", "New status"), type: "select", options: ["ACTIVE", "FROZEN", "DORMANT", "CLOSED"].map((v) => ({ value: v, label: v })) },
            { name: "reason", label: t("السبب", "Reason"), required: true }]} />
        </Card>
      )}
      <StatementView s={s} lang={lang} exportBase={`/api/staff/accounts/${a.id}/statement`} from={sp.from} to={sp.to} />
    </div>
  );
}
