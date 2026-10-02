import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { getLoan } from "@/server/services/loans";
import { PageTitle, Card, Table, Badge, Ltr, money, Grid, Stat, A } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client";

export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { staff, lang } = await requireStaffPage("loan.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const { id } = await params;
  const l = await getLoan(staff, id);
  const ep = `/api/staff/loans/${l.id}`;
  return (
    <div className="space-y-5">
      <PageTitle title={`${t("قرض", "Loan")} ${l.loanNumber}`} subtitle={`${tr(lang, l.product.nameAr, l.product.nameEn)} · ${tr(lang, l.customer.nameAr, l.customer.nameEn)}`} actions={<Badge v={l.status} lang={lang} />} />
      <Grid>
        <Stat label={t("الأصل", "Principal")} value={money(l.principal, l.currency)} />
        <Stat label={t("القائم", "Outstanding")} value={money(l.outstandingPrincipal, l.currency)} tone="blue" />
        <Stat label={t("العائد / المدة", "Rate / term")} value={`${l.annualRateBps / 100}% · ${l.termMonths}m`} />
        <Stat label={t("أيام التأخير / التصنيف", "DPD / class")} value={`${l.daysPastDue} · ${l.classification}`} tone={l.daysPastDue > 90 ? "red" : l.daysPastDue ? "amber" : "slate"} />
      </Grid>
      <Card title={t("الإجراءات", "Actions")}>
        <div className="flex flex-wrap items-start gap-2">
          <A href={`/staff/customers/${l.customerId}`}>{t("ملف العميل", "Customer file")}</A>
          {l.status === "APPLIED" && can(staff, "loan.recommend") && <ActionButton endpoint={ep} body={{ action: "RECOMMEND" }} label={t("توصية", "Recommend")} />}
          {l.status === "RECOMMENDED" && can(staff, "loan.approve") && <ActionButton endpoint={ep} body={{ action: "APPROVE" }} label={t("اعتماد", "Approve")} />}
          {["APPLIED", "RECOMMENDED"].includes(l.status) && (can(staff, "loan.recommend") || can(staff, "loan.approve")) && <ActionButton tone="danger" endpoint={ep} body={{ action: "REJECT" }} prompt={{ field: "reason", label: t("سبب الرفض", "Rejection reason") }} label={t("رفض", "Reject")} />}
          {l.status === "APPROVED" && can(staff, "loan.disburse") && <ActionButton endpoint={ep} body={{ action: "DISBURSE" }} label={t("صرف", "Disburse")} confirm={t("صرف القرض إلى حساب العميل؟", "Disburse to the customer's account?")} />}
        </div>
        {l.status === "DISBURSED" && can(staff, "loan.repay") && <div className="mt-3"><ApiForm compact idempotent endpoint={ep} extra={{ action: "REPAY" }} submitLabel={t("سداد من الحساب", "Repay from account")} fields={[{ name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true }]} /></div>}
      </Card>
      <Card title={t("جدول السداد (قسط ثابت)", "Amortization schedule (annuity)")}>
        <Table rows={l.installments} cols={[
          { h: "#", c: (i) => i.seq }, { h: t("الاستحقاق", "Due"), c: (i) => <Ltr>{i.dueDate.toISOString().slice(0, 10)}</Ltr> },
          { h: t("أصل", "Principal"), c: (i) => <Ltr>{money(i.principalDue, "")}</Ltr> }, { h: t("عائد", "Interest"), c: (i) => <Ltr>{money(i.interestDue, "")}</Ltr> },
          { h: t("غرامة", "Penalty"), c: (i) => <Ltr>{money(i.penaltyDue, "")}</Ltr> }, { h: t("القسط", "Instalment"), c: (i) => <Ltr>{money(i.principalDue + i.interestDue, "")}</Ltr> },
          { h: t("المسدد", "Paid"), c: (i) => <Ltr>{money(i.principalPaid + i.interestPaid + i.penaltyPaid, "")}</Ltr> }, { h: t("الحالة", "Status"), c: (i) => <Badge v={i.status} lang={lang} /> },
        ]} />
      </Card>
    </div>
  );
}
