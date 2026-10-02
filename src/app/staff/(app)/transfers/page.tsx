import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Notice } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client";
import { formatIban } from "@/lib/iban";
import { BANKS } from "@/server/services/transfers";

export default async function Transfers() {
  const { staff, lang } = await requireStaffPage("account.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const bw = branchWhere(staff);
  const ids = bw.branchId ? (await prisma.account.findMany({ where: bw, select: { id: true } })).map((a) => a.id) : undefined;
  const transfers = await prisma.transfer.findMany({ where: ids ? { fromAccountId: { in: ids } } : {}, orderBy: { createdAt: "desc" }, take: 100 });
  const accs = await prisma.account.findMany({ where: { id: { in: transfers.map((x) => x.fromAccountId) } }, select: { id: true, accountNumber: true } });
  const batches = can(staff, "clearing.manage") ? await prisma.clearingBatch.findMany({ orderBy: { createdAt: "desc" }, take: 30 }) : [];
  return (
    <div className="space-y-5">
      <PageTitle title={t("التحويلات والمقاصة", "Transfers & clearing")} />
      {can(staff, "transfer.create") && (
        <Card title={t("تحويل جديد (داخلي أو لبنك آخر عبر المقاصة)", "New transfer (internal, or other bank via clearing)")}>
          <ApiForm idempotent endpoint="/api/staff/transfers" submitLabel={t("تحويل", "Transfer")} fields={[
            { name: "fromAccountId", label: t("من حساب (IBAN)", "From account (IBAN)"), required: true, ltr: true },
            { name: "toAccountNumber", label: t("إلى IBAN", "To IBAN"), required: true, ltr: true },
            { name: "toName", label: t("اسم المستفيد", "Beneficiary name") }, { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true },
            { name: "description", label: t("البيان", "Description"), wide: true }]} />
          <p className="mt-2 text-xs text-slate-500">{t("البنوك المتاحة في المقاصة الوهمية:", "Banks available on the MOCK clearing:")} {Object.entries(BANKS).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
        </Card>
      )}
      <Card title={t("آخر التحويلات", "Recent transfers")}>
        <Table rows={transfers} cols={[
          { h: t("المرجع", "Ref"), c: (x) => <Ltr>{x.reference}</Ltr> }, { h: t("النوع", "Kind"), c: (x) => x.kind },
          { h: t("من", "From"), c: (x) => <Ltr>{formatIban(accs.find((a) => a.id === x.fromAccountId)?.accountNumber ?? "")}</Ltr> },
          { h: t("إلى", "To"), c: (x) => <span><Ltr>{formatIban(x.toAccountNumber ?? "")}</Ltr> {x.toName}</span> },
          { h: t("المبلغ", "Amount"), c: (x) => <Ltr>{money(x.amount, x.currency)}</Ltr> }, { h: t("الرسوم", "Fee"), c: (x) => <Ltr>{money(x.feeAmount, x.currency)}</Ltr> },
          { h: t("القناة", "Channel"), c: (x) => x.channel }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> }, { h: t("الوقت", "Time"), c: (x) => dt(x.createdAt) },
        ]} />
      </Card>
      {can(staff, "clearing.manage") && (
        <Card title={t("دفعات المقاصة (محول ACH وهمي)", "Clearing batches (MOCK ACH adapter)")}>
          <Notice>{t("المقاصة هنا محاكاة. الربط الفعلي يتم عبر شبكة ACH للبنك المركزي المصري / شبكة المدفوعات اللحظية (IPN) بعد الترخيص.", "Clearing is simulated. Real integration goes through CBE ACH / Instant Payment Network after licensing.")}</Notice>
          <div className="mt-3"><Table rows={batches} cols={[
            { h: "#", c: (b) => <Ltr>{b.batchNo}</Ltr> }, { h: t("العملة", "CCY"), c: (b) => b.currency }, { h: t("عدد", "Items"), c: (b) => b.itemCount },
            { h: t("الإجمالي", "Total"), c: (b) => <Ltr>{money(b.totalAmount, b.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (b) => <Badge v={b.status} lang={lang} /> },
            { h: "", c: (b) => b.status === "OPEN" ? <ActionButton endpoint={`/api/staff/clearing/${b.id}`} body={{ action: "SUBMIT" }} label={t("إرسال", "Submit")} /> : b.status === "SUBMITTED" ? <ActionButton endpoint={`/api/staff/clearing/${b.id}`} body={{ action: "SETTLE" }} label={t("تسوية", "Settle")} /> : null },
          ]} /></div>
        </Card>
      )}
    </div>
  );
}
