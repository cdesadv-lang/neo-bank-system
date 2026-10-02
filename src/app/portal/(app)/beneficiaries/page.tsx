import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Ltr, A } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client";
import { formatIban } from "@/lib/iban";

export default async function Beneficiaries() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const rows = await prisma.beneficiary.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" } });
  return (
    <div className="space-y-5">
      <PageTitle title={t("المستفيدون", "Beneficiaries")} />
      <Card>
        <Table rows={rows} cols={[{ h: t("الاسم", "Name"), c: (b) => b.name }, { h: "IBAN", c: (b) => <Ltr>{formatIban(b.accountNumber)}</Ltr> }, { h: t("البنك", "Bank"), c: (b) => b.bankName },
          { h: "", c: (b) => <div className="flex gap-2"><A href={`/portal/transfers?to=${b.accountNumber}&name=${encodeURIComponent(b.name)}`}>{t("تحويل", "Transfer")}</A><ActionButton tone="ghost" method="DELETE" endpoint={`/api/portal/beneficiaries/${b.id}`} confirm={t("حذف المستفيد؟", "Remove beneficiary?")} label={t("حذف", "Remove")} /></div> }]} />
      </Card>
      <Card title={t("إضافة مستفيد", "Add beneficiary")}>
        <ApiForm endpoint="/api/portal/beneficiaries" submitLabel={t("إضافة", "Add")} showResult={false} fields={[{ name: "name", label: t("الاسم", "Name"), required: true }, { name: "accountNumber", label: "IBAN", required: true, ltr: true, placeholder: "EG.." }]} />
      </Card>
    </div>
  );
}
