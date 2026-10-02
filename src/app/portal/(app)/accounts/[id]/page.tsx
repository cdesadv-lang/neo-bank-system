import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { myAccount, myStatement } from "@/server/services/portal";
import { PageTitle, Grid, Stat, money } from "@/components/ui";
import { StatementView } from "@/components/statement";
import { formatIban } from "@/lib/iban";

export default async function PortalAccount({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const { id } = await params;
  const sp = await searchParams;
  const a = await myAccount(customer.customerId, id);
  const s = await myStatement(customer.customerId, id, sp.from ? new Date(sp.from) : undefined, sp.to ? new Date(sp.to + "T23:59:59Z") : undefined);
  return (
    <div className="space-y-5">
      <PageTitle title={formatIban(a.accountNumber)} subtitle={`${a.type} · ${a.currency}`} />
      <Grid cols={3}>
        <Stat label={t("الرصيد المتاح", "Available balance")} value={money(a.balance, a.currency)} tone="green" />
        <Stat label={t("سعر العائد", "Interest rate")} value={`${(a.termDeposit?.rateBps ?? a.interestRateBps) / 100}%`} />
        {a.termDeposit ? <Stat label={t("تاريخ الاستحقاق", "Maturity")} value={a.termDeposit.maturityDate.toISOString().slice(0, 10)} /> : <Stat label={t("العائد المستحق", "Accrued interest")} value={a.accruedInterest.toFixed(2)} />}
      </Grid>
      <StatementView s={s} lang={lang} exportBase={`/api/portal/accounts/${a.id}/statement`} from={sp.from} to={sp.to} />
    </div>
  );
}
