import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { listTills } from "@/server/services/teller";
import { PageTitle, Card, Table, Badge, Ltr, money, dt } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Tills() {
  const { staff, lang } = await requireStaffPage("till.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const tills = await listTills(staff);
  const tellers = await prisma.staff.findMany({ where: { ...branchWhere(staff), role: "TELLER", active: true } });
  const nameOf = (id: string | null) => tellers.find((x) => x.id === id)?.username ?? (id ? "…" : "—");
  const balancings = await prisma.tillBalancing.findMany({ where: { till: branchWhere(staff) }, orderBy: { createdAt: "desc" }, take: 20, include: { till: true } });
  const opts = tills.filter((x) => x.kind !== "ATM").map((x) => ({ value: x.id, label: `${x.code} · ${x.currency} · ${money(x.balance, x.currency)}` }));
  return (
    <div className="space-y-5">
      <PageTitle title={t("الخزائن والخزينة الرئيسية", "Tills & vault")} />
      <Card>
        <Table rows={tills} cols={[
          { h: t("الكود", "Code"), c: (x) => <Ltr>{x.code}</Ltr> }, { h: t("النوع", "Kind"), c: (x) => x.kind }, { h: t("الفرع", "Branch"), c: (x) => tr(lang, x.branch.nameAr, x.branch.nameEn) },
          { h: t("العملة", "CCY"), c: (x) => x.currency }, { h: t("الرصيد", "Balance"), c: (x) => <Ltr>{money(x.balance, x.currency)}</Ltr> },
          { h: t("الصراف", "Teller"), c: (x) => <Ltr>{nameOf(x.assignedToId)}</Ltr> }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> },
        ]} />
      </Card>
      {can(staff, "till.manage") && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={t("نقل نقدية (خزينة رئيسية ↔ صراف)", "Move cash (vault ↔ till)")}>
            <ApiForm idempotent endpoint="/api/staff/tills" extra={{ action: "MOVE" }} submitLabel={t("نقل", "Move")} fields={[
              { name: "fromTillId", label: t("من", "From"), type: "select", options: opts }, { name: "toTillId", label: t("إلى", "To"), type: "select", options: opts },
              { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true }]} />
          </Card>
          <Card title={t("تخصيص خزينة لصراف", "Assign a till to a teller")}>
            <ApiForm endpoint="/api/staff/tills" extra={{ action: "ASSIGN" }} submitLabel={t("تخصيص", "Assign")} fields={[
              { name: "tellerId", label: t("الصراف", "Teller"), type: "select", options: tellers.map((x) => ({ value: x.id, label: `${x.username} · ${tr(lang, x.fullNameAr, x.fullNameEn)}` })) },
              { name: "currency", label: t("العملة", "Currency"), type: "select", options: ["EGP", "USD", "EUR", "SAR"].map((v) => ({ value: v, label: v })) }]} />
          </Card>
        </div>
      )}
      <Card title={t("سجل الموازنات", "Balancing history")}>
        <Table rows={balancings} cols={[
          { h: t("الخزينة", "Till"), c: (b) => <Ltr>{b.till.code}</Ltr> }, { h: t("الدفتري", "System"), c: (b) => <Ltr>{money(b.systemBalance, b.till.currency)}</Ltr> },
          { h: t("المعدود", "Counted"), c: (b) => <Ltr>{money(b.countedBalance, b.till.currency)}</Ltr> },
          { h: t("الفرق", "Variance"), c: (b) => <span className={b.variance === 0n ? "" : "font-bold text-rose-700"}><Ltr>{money(b.variance, b.till.currency)}</Ltr></span> }, { h: t("الوقت", "Time"), c: (b) => dt(b.createdAt) },
        ]} />
      </Card>
    </div>
  );
}
