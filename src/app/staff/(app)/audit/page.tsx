import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Ltr, dt, Json } from "@/components/ui";

export default async function Audit({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { lang } = await requireStaffPage("audit.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const q = sp.q;
  const rows = await prisma.auditLog.findMany({ where: q ? { OR: [{ action: { contains: q.toUpperCase() } }, { actorName: { contains: q } }, { entityId: q }] } : {}, orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("سجل التدقيق", "Audit log")} subtitle={t("سجل غير قابل للتعديل أو الحذف (محمي بقاعدة البيانات)", "Append-only (enforced by database triggers)")} />
      <Card>
        <form className="mb-3 flex gap-2 text-sm"><input name="q" defaultValue={q} placeholder={t("الإجراء / المستخدم / المعرّف", "Action / user / entity id")} className="w-72 rounded border px-2 py-1.5" /><button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("بحث", "Search")}</button></form>
        <Table rows={rows} cols={[
          { h: t("الوقت", "Time"), c: (r) => <span className="whitespace-nowrap">{dt(r.createdAt)}</span> }, { h: t("المنفذ", "Actor"), c: (r) => <Ltr>{r.actorType}:{r.actorName}</Ltr> },
          { h: t("الإجراء", "Action"), c: (r) => <Ltr>{r.action}</Ltr> }, { h: t("الكيان", "Entity"), c: (r) => <Ltr>{r.entityType} {r.entityId?.slice(-8)}</Ltr> }, { h: "IP", c: (r) => <Ltr>{r.ip}</Ltr> },
          { h: t("قبل/بعد", "Before/after"), c: (r) => (r.before || r.after) ? <details><summary className="cursor-pointer text-xs text-sky-700">diff</summary><Json v={{ before: r.before, after: r.after }} /></details> : null },
        ]} />
      </Card>
    </div>
  );
}
