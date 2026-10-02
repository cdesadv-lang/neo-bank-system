import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, CHECKER_ROLES } from "@/server/rbac";
import { listApprovals } from "@/server/services/approvals";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, dt, Json } from "@/components/ui";
import { ActionButton } from "@/components/client";

export default async function Approvals({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { staff, lang } = await requireStaffPage("approval.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const rows = await listApprovals(staff, sp.status ?? "PENDING");
  const people = await prisma.staff.findMany({ where: { id: { in: rows.flatMap((r) => [r.makerId, r.checkerId ?? ""]) } }, select: { id: true, username: true } });
  const who = (id: string | null) => people.find((p) => p.id === id)?.username ?? "—";
  return (
    <div className="space-y-5">
      <PageTitle title={t("الموافقات (مبدأ الأربع أعين)", "Approvals (maker-checker)")} subtitle={t("لا يمكن لمنشئ الطلب اعتماده؛ ويجب أن يكون المعتمد من الأدوار المخولة.", "The maker can never approve their own request; the checker must hold an authorised role.")} />
      <Card actions={<form className="flex gap-1 text-sm"><select name="status" defaultValue={sp.status ?? "PENDING"} className="rounded border px-2 py-1">{["PENDING", "APPROVED", "REJECTED", "FAILED"].map((s) => <option key={s}>{s}</option>)}</select><button className="rounded bg-slate-800 px-2 py-1 text-white">{t("عرض", "Show")}</button></form>}>
        <Table rows={rows} cols={[
          { h: t("النوع", "Type"), c: (r) => <span>{r.type}<div className="text-xs text-slate-500">{(CHECKER_ROLES[r.type] ?? []).join(", ")}</div></span> },
          { h: t("الملخص", "Summary"), c: (r) => r.summary }, { h: t("المنشئ", "Maker"), c: (r) => <Ltr>{who(r.makerId)}</Ltr> }, { h: t("المعتمد", "Checker"), c: (r) => <Ltr>{who(r.checkerId)}</Ltr> },
          { h: t("التفاصيل", "Payload"), c: (r) => <details><summary className="cursor-pointer text-xs text-sky-700">JSON</summary><Json v={r.payload} /></details> },
          { h: t("الحالة", "Status"), c: (r) => <span><Badge v={r.status} lang={lang} />{r.comment && <div className="text-xs">{r.comment}</div>}</span> }, { h: t("الوقت", "Time"), c: (r) => dt(r.createdAt) },
          { h: "", c: (r) => r.status === "PENDING" && can(staff, "approval.decide") && r.makerId !== staff.id && (CHECKER_ROLES[r.type] ?? []).includes(staff.role) ? (
            <div className="flex gap-1"><ActionButton endpoint={`/api/staff/approvals/${r.id}`} body={{ decision: "APPROVE" }} label={t("اعتماد", "Approve")} /><ActionButton tone="danger" endpoint={`/api/staff/approvals/${r.id}`} body={{ decision: "REJECT" }} prompt={{ field: "comment", label: t("سبب الرفض", "Reason") }} label={t("رفض", "Reject")} /></div>
          ) : r.status === "PENDING" && r.makerId === staff.id ? <span className="text-xs text-slate-500">{t("بانتظار موظف آخر", "Awaiting another officer")}</span> : null },
        ]} />
      </Card>
    </div>
  );
}
