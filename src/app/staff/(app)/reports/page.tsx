import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { PageTitle, Card, A } from "@/components/ui";
import { REPORTS } from "@/lib/reports-meta";



export default async function Reports() {
  const { lang } = await requireStaffPage("report.read");
  return (
    <div className="space-y-5">
      <PageTitle title={tr(lang, "التقارير", "Reports")} />
      <div className="grid gap-3 md:grid-cols-3">
        {REPORTS.map((r) => <Card key={r.id}><A href={`/staff/reports/${r.id}`}>{tr(lang, r.ar, r.en)}</A><div className="mt-1 text-xs text-slate-400" dir="ltr">GET /api/staff/reports/{r.id}</div></Card>)}
      </div>
    </div>
  );
}
