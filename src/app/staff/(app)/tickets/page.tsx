import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { listTicketsStaff } from "@/server/services/tickets";
import { PageTitle, Card, Table, Badge, Ltr, dt, A } from "@/components/ui";

export default async function Tickets({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { staff, lang } = await requireStaffPage("ticket.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const rows = await listTicketsStaff(staff, sp.status || undefined);
  return (
    <div className="space-y-5">
      <PageTitle title={t("الشكاوى والطلبات (CRM)", "Tickets (CRM)")} />
      <Card actions={<form className="flex gap-1 text-sm"><select name="status" defaultValue={sp.status ?? ""} className="rounded border px-2 py-1"><option value="">{t("الكل", "All")}</option>{["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => <option key={s}>{s}</option>)}</select><button className="rounded bg-slate-800 px-2 py-1 text-white">{t("عرض", "Show")}</button></form>}>
        <Table rows={rows} cols={[
          { h: "#", c: (x) => <A href={`/staff/tickets/${x.id}`}><Ltr>{x.ticketNo}</Ltr></A> }, { h: t("الموضوع", "Subject"), c: (x) => <A href={`/staff/tickets/${x.id}`}>{x.subject}</A> },
          { h: t("العميل", "Customer"), c: (x) => tr(lang, x.customer.nameAr, x.customer.nameEn) }, { h: t("التصنيف", "Category"), c: (x) => x.category },
          { h: t("الرسائل", "Messages"), c: (x) => x.messages.length }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> }, { h: t("آخر تحديث", "Updated"), c: (x) => dt(x.updatedAt) },
        ]} />
      </Card>
    </div>
  );
}
