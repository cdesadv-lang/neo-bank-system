import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { todayStr } from "@/lib/dates";
import { PageTitle, Card, Table, Badge, dt, Json, Notice } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Eod() {
  const { lang } = await requireStaffPage("eod.run");
  const t = (a: string, e: string) => tr(lang, a, e);
  const runs = await prisma.eodRun.findMany({ orderBy: { businessDate: "desc" }, take: 60 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("إقفال نهاية اليوم", "End-of-day batch")} />
      <Notice tone="sky">{t("الخطوات: احتساب العائد اليومي للودائع والتوفير ← ترحيل العائد الشهري ← استحقاق الودائع ← تحصيل أقساط القروض والغرامات وتصنيف التأخير ← فك حجوزات البطاقات المنتهية ← رسوم الشهر ← لقطة الأرصدة ← مطابقة دفتر الأستاذ. لا يمكن تشغيله مرتين لنفس التاريخ. يمكن جدولته عبر cron: npm run eod", "Steps: daily interest accrual → monthly capitalisation → TD maturities → loan auto-collection, penalties & DPD classification → release expired card holds → month-end fees → balance snapshots → GL reconciliation. Cannot run twice for the same date. Schedule with cron: npm run eod")}</Notice>
      <Card title={t("تشغيل", "Run")}>
        <ApiForm endpoint="/api/staff/eod" submitLabel={t("تشغيل الإقفال", "Run EOD")} confirm={t("تشغيل إقفال اليوم؟", "Run end of day?")} fields={[{ name: "date", label: t("تاريخ العمل", "Business date"), type: "date", defaultValue: todayStr() }]} />
      </Card>
      <Card title={t("سجل التشغيل", "Run history")}>
        <Table rows={runs} cols={[
          { h: t("التاريخ", "Date"), c: (r) => <span dir="ltr">{r.businessDate.toISOString().slice(0, 10)}</span> }, { h: t("الحالة", "Status"), c: (r) => <Badge v={r.status} lang={lang} /> },
          { h: t("البداية", "Started"), c: (r) => dt(r.startedAt) }, { h: t("النهاية", "Finished"), c: (r) => dt(r.finishedAt) },
          { h: t("الملخص", "Summary"), c: (r) => r.error ? <span className="text-rose-700">{r.error}</span> : <details><summary className="cursor-pointer text-xs text-sky-700">JSON</summary><Json v={r.summary} /></details> },
        ]} />
      </Card>
    </div>
  );
}
