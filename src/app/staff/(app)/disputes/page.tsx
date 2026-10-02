import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { listDisputes } from "@/server/services/card-auth";
import { PageTitle, Card, Table, Badge, Ltr, money, dt } from "@/components/ui";
import { ActionButton } from "@/components/client";

export default async function Disputes() {
  const { staff, lang } = await requireStaffPage("card.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const rows = await listDisputes(staff);
  const ep = (id: string) => `/api/staff/disputes/${id}`;
  return (
    <div className="space-y-5">
      <PageTitle title={t("اعتراضات البطاقات والاسترداد", "Card disputes & chargebacks")} subtitle={t("اعتراض ← استرداد مؤقت للعميل ← حسم لصالح العميل أو التاجر. اعتراضات (لم يتم صرف النقدية) بأجهزتنا تُحسم بعكس العملية بعد مطابقة الصراف.", "Dispute → provisional credit → resolved for customer or merchant. Own-ATM 'cash not dispensed' is resolved by reversing after ATM reconciliation.")} />
      <Card>
        <Table rows={rows} cols={[
          { h: "#", c: (d) => <Ltr>{d.disputeNo}</Ltr> }, { h: t("العميل", "Customer"), c: (d) => tr(lang, d.authorization.card.customer.nameAr, d.authorization.card.customer.nameEn) },
          { h: t("العملية", "Transaction"), c: (d) => <span>{d.authorization.channel} · {d.authorization.merchantName ?? d.authorization.terminalId} · <Ltr>{d.authorization.rrn}</Ltr></span> },
          { h: t("السبب", "Reason"), c: (d) => <span>{d.reason}{d.description && <div className="text-xs text-slate-500">{d.description}</div>}</span> },
          { h: t("المبلغ", "Amount"), c: (d) => <Ltr>{money(d.amount, d.authorization.currency)}</Ltr> }, { h: t("من", "By"), c: (d) => d.openedBy },
          { h: t("الحالة", "Status"), c: (d) => <Badge v={d.status} lang={lang} /> }, { h: t("التاريخ", "Date"), c: (d) => dt(d.createdAt) },
          { h: "", c: (d) => can(staff, "card.dispute") ? (
            <div className="flex flex-wrap gap-1">
              {d.status === "OPEN" && d.authorization.channel !== "ATM" && <ActionButton endpoint={ep(d.id)} body={{ action: "CHARGEBACK" }} label={t("استرداد مؤقت", "Chargeback")} />}
              {d.status === "OPEN" && d.authorization.channel === "ATM" && d.authorization.acquirer === "OWN" && <ActionButton endpoint={ep(d.id)} body={{ action: "RESOLVE_CUSTOMER" }} confirm={t("تأكيد عدم الصرف ومطابقة الصراف؟", "Confirm not dispensed per ATM reconciliation?")} label={t("لصالح العميل (عكس)", "For customer (reverse)")} />}
              {d.status === "CHARGEBACK_RAISED" && <><ActionButton endpoint={ep(d.id)} body={{ action: "RESOLVE_CUSTOMER" }} label={t("لصالح العميل", "Won")} /><ActionButton tone="ghost" endpoint={ep(d.id)} body={{ action: "RESOLVE_MERCHANT" }} label={t("لصالح التاجر", "Lost")} /></>}
              {d.status === "OPEN" && <ActionButton tone="danger" endpoint={ep(d.id)} body={{ action: "REJECT" }} prompt={{ field: "note", label: t("ملاحظة", "Note") }} label={t("رفض", "Reject")} />}
            </div>) : null },
        ]} />
      </Card>
    </div>
  );
}
