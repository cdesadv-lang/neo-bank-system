import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { listJournals } from "@/server/services/journals";
import { trialBalance } from "@/server/services/reports";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt } from "@/components/ui";
import { ApiForm, ActionButton, Tabs } from "@/components/client";

export default async function Journals({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
  const { staff, lang } = await requireStaffPage("journal.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const journals = await listJournals(staff, { q: sp.q, type: sp.type, take: 100 });
  const tb = can(staff, "gl.read") ? await trialBalance() : null;
  const gls = await prisma.glAccount.findMany({ where: { allowManualPosting: true, isControl: false }, orderBy: { code: "asc" } });
  const jl = (
    <Card>
      <form className="mb-3 flex gap-2 text-sm"><input name="q" defaultValue={sp.q} placeholder={t("رقم القيد / المرجع / البيان", "Entry no / reference / description")} className="w-72 rounded border px-2 py-1.5" /><input name="type" defaultValue={sp.type} placeholder="TYPE" dir="ltr" className="w-40 rounded border px-2 py-1.5" /><button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("بحث", "Search")}</button></form>
      <Table rows={journals} cols={[
        { h: "#", c: (e) => <Ltr>{e.entryNo}</Ltr> }, { h: t("النوع", "Type"), c: (e) => e.type }, { h: t("البيان", "Description"), c: (e) => e.description },
        { h: t("الأطراف", "Lines"), c: (e) => <div className="text-xs" dir="ltr">{e.lines.map((l) => <div key={l.id}>{l.glAccount.code} {l.debit ? `Dr ${money(l.debit, "")}` : `Cr ${money(l.credit, "")}`}</div>)}</div> },
        { h: t("الوقت", "Time"), c: (e) => dt(e.postedAt) }, { h: t("القناة", "Channel"), c: (e) => e.channel }, { h: t("الحالة", "Status"), c: (e) => <Badge v={e.status} lang={lang} /> },
        { h: "", c: (e) => can(staff, "journal.reverse") && e.status === "POSTED" && !e.reversalOfId ? <ActionButton tone="ghost" endpoint={`/api/staff/journals/${e.id}/reverse`} body={{}} prompt={{ field: "reason", label: t("سبب العكس (يتطلب موافقة)", "Reversal reason (needs approval)") }} label={t("طلب عكس", "Request reversal")} /> : null },
      ]} />
    </Card>
  );
  const tbView = tb && (
    <Card title={t("ميزان المراجعة", "Trial balance")}>
      <div className="mb-2 flex flex-wrap gap-3 text-sm">{Object.entries(tb.totals).map(([c, v]) => <span key={c} className={v.balanced ? "text-emerald-700" : "font-bold text-rose-700"} dir="ltr">{c}: Dr {money(v.debit, "")} / Cr {money(v.credit, "")} {v.balanced ? "✓" : "✗"}</span>)}</div>
      <Table rows={tb.rows} cols={[{ h: "GL", c: (r) => <Ltr>{r.code}</Ltr> }, { h: t("الحساب", "Account"), c: (r) => tr(lang, r.nameAr, r.nameEn) }, { h: t("العملة", "CCY"), c: (r) => r.currency }, { h: t("مدين", "Debit"), c: (r) => <Ltr>{money(r.debit, "")}</Ltr> }, { h: t("دائن", "Credit"), c: (r) => <Ltr>{money(r.credit, "")}</Ltr> }, { h: t("الرصيد", "Balance"), c: (r) => <Ltr>{money(r.balance, "")}</Ltr> }]} />
    </Card>
  );
  const manual = can(staff, "journal.manual") && (
    <Card title={t("قيد يدوي (يتطلب اعتماد المالية)", "Manual journal (requires Finance approval)")}>
      <p className="mb-2 text-xs text-slate-500" dir="ltr">{gls.map((g) => `${g.code} ${g.nameEn}`).join(" · ")}</p>
      <ApiForm endpoint="/api/staff/journals/manual" submitLabel={t("إرسال للموافقة", "Submit for approval")} fields={[
        { name: "currency", label: t("العملة", "Currency"), type: "select", options: ["EGP", "USD", "EUR", "SAR"].map((v) => ({ value: v, label: v })) },
        { name: "description", label: t("البيان", "Description"), required: true },
        { name: "lines", label: t("الأطراف (JSON)", "Lines (JSON)"), type: "json", wide: true, defaultValue: JSON.stringify([{ glCode: "5030", debit: "100.00" }, { glCode: "1100", credit: "100.00" }]) }]} />
    </Card>
  );
  return (
    <div className="space-y-5">
      <PageTitle title={t("القيود ودفتر الأستاذ العام", "Journals & general ledger")} subtitle={t("القيود غير قابلة للتعديل أو الحذف؛ التصحيح بقيد عكسي فقط.", "Entries are immutable; corrections are made only by reversal.")} />
      <Tabs tabs={[{ id: "j", label: t("القيود", "Journals"), content: jl }, ...(tbView ? [{ id: "tb", label: t("ميزان المراجعة", "Trial balance"), content: tbView }] : []), ...(manual ? [{ id: "m", label: t("قيد يدوي", "Manual journal"), content: manual }] : [])]} />
    </div>
  );
}
