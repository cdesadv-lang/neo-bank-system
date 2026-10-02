import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { listAlerts, listCases } from "@/server/services/aml";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, A } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/client";

export default async function Aml({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { staff, lang } = await requireStaffPage("aml.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const alerts = await listAlerts(staff, { status: sp.status ?? "OPEN" });
  const cases = await listCases(staff);
  const rules = await prisma.amlRule.findMany({ orderBy: { code: "asc" } });
  const m = can(staff, "aml.manage");
  return (
    <div className="space-y-5">
      <PageTitle title={t("مكافحة غسل الأموال", "AML monitoring")} subtitle={t("القواعد تعمل لحظياً عند ترحيل كل قيد", "Rules run in real time on every posting")} />
      <Card title={t("القواعد", "Rules")}>
        <Table rows={rules} cols={[{ h: t("الكود", "Code"), c: (r) => <Ltr>{r.code}</Ltr> }, { h: t("الوصف", "Description"), c: (r) => tr(lang, r.nameAr, r.nameEn) }, { h: t("النوع", "Kind"), c: (r) => r.kind }, { h: t("الحد", "Threshold"), c: (r) => <Ltr>{r.threshold ? money(r.threshold) : "—"}</Ltr> }, { h: t("الخطورة", "Severity"), c: (r) => r.severity }, { h: "", c: (r) => (r.active ? "✓" : "✗") }]} />
      </Card>
      <Card title={t("التنبيهات", "Alerts")} actions={<form className="flex gap-1 text-sm"><select name="status" defaultValue={sp.status ?? "OPEN"} className="rounded border px-2 py-1">{["OPEN", "IN_REVIEW", "ESCALATED", "CLOSED_FALSE_POSITIVE", "CLOSED"].map((s) => <option key={s}>{s}</option>)}</select><button className="rounded bg-slate-800 px-2 py-1 text-white">{t("عرض", "Show")}</button></form>}>
        <Table rows={alerts} cols={[
          { h: "#", c: (a) => <Ltr>{a.alertNo}</Ltr> }, { h: t("العميل", "Customer"), c: (a) => <A href={`/staff/customers/${a.customerId}`}>{tr(lang, a.customer.nameAr, a.customer.nameEn)}</A> },
          { h: t("القاعدة", "Rule"), c: (a) => <Ltr>{a.rule.code}</Ltr> }, { h: t("التفاصيل", "Details"), c: (a) => a.details }, { h: t("المبلغ", "Amount"), c: (a) => <Ltr>{a.amount !== null ? money(a.amount, a.currency ?? "EGP") : "—"}</Ltr> },
          { h: t("الخطورة", "Severity"), c: (a) => <Badge v={a.severity} /> }, { h: t("الحالة", "Status"), c: (a) => <Badge v={a.status} lang={lang} /> }, { h: t("الوقت", "Time"), c: (a) => dt(a.createdAt) },
          { h: "", c: (a) => m && ["OPEN", "IN_REVIEW"].includes(a.status) ? <div className="flex gap-1">
            <ActionButton tone="ghost" endpoint={`/api/staff/aml/alerts/${a.id}`} body={{ status: "CLOSED_FALSE_POSITIVE" }} label={t("إنذار كاذب", "False positive")} />
            <ActionButton endpoint="/api/staff/aml/cases" body={{ alertIds: [a.id] }} label={t("فتح قضية", "Open case")} /></div> : null },
        ]} />
      </Card>
      <Card title={t("القضايا", "Cases")}>
        <Table rows={cases} cols={[
          { h: "#", c: (c) => <Ltr>{c.caseNo}</Ltr> }, { h: t("العميل", "Customer"), c: (c) => tr(lang, c.customer.nameAr, c.customer.nameEn) }, { h: t("التنبيهات", "Alerts"), c: (c) => c.alerts.map((a) => a.rule.code).join(", ") },
          { h: t("الملاحظات", "Notes"), c: (c) => <div className="text-xs">{(c.notes as { by: string; text: string; at: string }[]).map((n, i) => <div key={i}>{n.by}: {n.text}</div>)}</div> },
          { h: t("القرار", "Decision"), c: (c) => c.decision ?? "—" }, { h: t("الحالة", "Status"), c: (c) => <Badge v={c.status} lang={lang} /> },
          { h: "", c: (c) => m && c.status !== "CLOSED" ? <div className="space-y-1">
            <ApiForm compact endpoint={`/api/staff/aml/cases/${c.id}`} extra={{ action: "NOTE" }} submitLabel={t("ملاحظة", "Note")} showResult={false} fields={[{ name: "text", label: "", required: true }]} />
            <div className="flex gap-1">{["FALSE_POSITIVE", "SAR_FILED", "ACCOUNT_FROZEN"].map((d) => <ActionButton key={d} tone={d === "FALSE_POSITIVE" ? "ghost" : "danger"} endpoint={`/api/staff/aml/cases/${c.id}`} body={{ action: "CLOSE", decision: d }} label={d} confirm={d === "ACCOUNT_FROZEN" ? t("سيتم طلب تجميد الحسابات. متابعة؟", "This requests account freezes. Continue?") : undefined} />)}</div>
          </div> : null },
        ]} />
      </Card>
    </div>
  );
}
