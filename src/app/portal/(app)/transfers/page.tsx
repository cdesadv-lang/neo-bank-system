import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { myAccounts, PORTAL_DAILY_LIMIT } from "@/server/services/portal";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt } from "@/components/ui";
import { OtpFlow } from "@/components/client";
import { formatIban } from "@/lib/iban";

export default async function PortalTransfers({ searchParams }: { searchParams: Promise<{ to?: string; name?: string }> }) {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const accounts = (await myAccounts(customer.customerId)).filter((a) => a.type !== "TERM_DEPOSIT" && a.status === "ACTIVE");
  const bens = await prisma.beneficiary.findMany({ where: { customerId: customer.customerId }, orderBy: { name: "asc" } });
  const history = await prisma.transfer.findMany({ where: { fromAccountId: { in: accounts.map((a) => a.id) } }, orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("التحويلات", "Transfers")} subtitle={`${t("الحد اليومي للخدمات الرقمية", "Daily online limit")}: ${money(PORTAL_DAILY_LIMIT)}`} />
      <Card title={t("تحويل جديد", "New transfer")}>
        {bens.length > 0 && <p className="mb-2 text-xs text-slate-500">{t("المستفيدون:", "Beneficiaries:")} {bens.map((b) => <a key={b.id} className="me-2 text-sky-700 hover:underline" href={`/portal/transfers?to=${b.accountNumber}&name=${encodeURIComponent(b.name)}`}>{b.name}</a>)}</p>}
        <OtpFlow idempotent startEndpoint="/api/portal/transfers/start" confirmEndpoint="/api/portal/transfers/confirm" fields={[
          { name: "fromAccountId", label: t("من حساب", "From account"), type: "select", options: accounts.map((a) => ({ value: a.id, label: `${formatIban(a.accountNumber)} · ${money(a.balance, a.currency)}` })) },
          { name: "toAccountNumber", label: t("إلى IBAN", "To IBAN"), required: true, ltr: true, defaultValue: sp.to ?? "" },
          { name: "toName", label: t("اسم المستفيد", "Beneficiary name"), defaultValue: sp.name ?? "" }, { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true },
          { name: "description", label: t("البيان", "Description"), wide: true }]}
          labels={{ start: t("متابعة", "Continue"), confirm: t("تأكيد التحويل", "Confirm transfer"), code: t("رمز التحقق المرسل لموبايلك", "Code sent to your mobile"), sent: t("راجع البيانات ثم أدخل رمز التحقق", "Review the details and enter the verification code"), done: t("تم التحويل بنجاح", "Transfer completed"), cancel: t("إلغاء", "Cancel") }} />
        <p className="mt-2 text-xs text-slate-500">{t("التحويل لبنوك أخرى يتم عبر مقاصة وهمية (MOCK) ويظهر (مرسل) حتى التسوية.", "Transfers to other banks go via a MOCK clearing and show SUBMITTED until settled.")}</p>
      </Card>
      <Card title={t("سجل التحويلات", "Transfer history")}>
        <Table rows={history} cols={[{ h: t("المرجع", "Ref"), c: (x) => <Ltr>{x.reference}</Ltr> }, { h: t("إلى", "To"), c: (x) => <span>{x.toName} <Ltr>{formatIban(x.toAccountNumber ?? "")}</Ltr></span> }, { h: t("المبلغ", "Amount"), c: (x) => <Ltr>{money(x.amount, x.currency)}</Ltr> }, { h: t("الرسوم", "Fee"), c: (x) => <Ltr>{money(x.feeAmount, x.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> }, { h: t("الوقت", "Time"), c: (x) => dt(x.createdAt) }]} />
      </Card>
    </div>
  );
}
