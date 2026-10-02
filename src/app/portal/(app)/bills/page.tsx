import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { myAccounts } from "@/server/services/portal";
import { MockBillerAdapter } from "@/server/services/billers";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Ltr, money, dt, Notice } from "@/components/ui";
import { OtpFlow } from "@/components/client";
import { formatIban } from "@/lib/iban";

export default async function Bills() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const accounts = (await myAccounts(customer.customerId)).filter((a) => a.type !== "TERM_DEPOSIT" && a.status === "ACTIVE" && a.currency === "EGP");
  const billers = MockBillerAdapter.list();
  const history = await prisma.billPayment.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("دفع الفواتير", "Bill payments")} />
      <Notice>{t("مزودو الفواتير هنا وهميون (MOCK) لأغراض العرض. الربط الفعلي يتم عبر مجمّع مدفوعات مرخص (مثل فوري/ Khales).", "Billers here are MOCK for demo. Real integration goes through a licensed aggregator (e.g. Fawry / Khales).")}</Notice>
      <Card>
        <OtpFlow idempotent startEndpoint="/api/portal/bills/start" confirmEndpoint="/api/portal/bills/confirm" fields={[
          { name: "accountId", label: t("من حساب", "From account"), type: "select", options: accounts.map((a) => ({ value: a.id, label: `${formatIban(a.accountNumber)} · ${money(a.balance, a.currency)}` })) },
          { name: "billerCode", label: t("الجهة", "Biller"), type: "select", options: billers.map((b) => ({ value: b.code, label: tr(lang, b.nameAr, b.nameEn) })) },
          { name: "billReference", label: t("رقم الاشتراك / العداد", "Subscriber / meter no."), required: true, ltr: true },
          { name: "amount", label: t("المبلغ (اتركه فارغاً للاستعلام)", "Amount (blank = inquiry amount)"), type: "number" }]}
          labels={{ start: t("استعلام ومتابعة", "Inquire & continue"), confirm: t("تأكيد الدفع", "Confirm payment"), code: t("رمز التحقق", "Verification code"), sent: t("أدخل رمز التحقق لإتمام الدفع", "Enter the code to complete payment"), done: t("تم الدفع", "Paid"), cancel: t("إلغاء", "Cancel") }} />
      </Card>
      <Card title={t("السجل", "History")}>
        <Table rows={history} cols={[{ h: t("المرجع", "Ref"), c: (b) => <Ltr>{b.reference}</Ltr> }, { h: t("الجهة", "Biller"), c: (b) => b.billerName }, { h: t("رقم الاشتراك", "Ref no."), c: (b) => <Ltr>{b.billReference}</Ltr> }, { h: t("المبلغ", "Amount"), c: (b) => <Ltr>{money(b.amount, b.currency)}</Ltr> }, { h: t("الوقت", "Time"), c: (b) => dt(b.createdAt) }]} />
      </Card>
    </div>
  );
}
