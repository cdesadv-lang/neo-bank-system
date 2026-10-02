import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Badge, dt, A } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { staff, lang } = await requireStaffPage("ticket.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const { id } = await params;
  const x = await prisma.supportTicket.findFirst({ where: { id, customer: branchWhere(staff) }, include: { customer: true, messages: { orderBy: { createdAt: "asc" } } } });
  if (!x) notFound();
  const ep = `/api/staff/tickets/${x.id}`;
  return (
    <div className="space-y-5">
      <PageTitle title={`${x.ticketNo} — ${x.subject}`} subtitle={x.category} actions={<Badge v={x.status} lang={lang} />} />
      <p className="text-sm"><A href={`/staff/customers/${x.customerId}`}>{tr(lang, x.customer.nameAr, x.customer.nameEn)}</A></p>
      <Card>
        <div className="space-y-3">
          {x.messages.map((m) => (
            <div key={m.id} className={`rounded-lg p-3 text-sm ${m.authorType === "STAFF" ? "bg-sky-50" : "bg-slate-100"}`}>
              <div className="mb-1 text-xs text-slate-500">{m.authorName} · {dt(m.createdAt)}</div>
              <div className="whitespace-pre-wrap">{m.body}</div>
            </div>
          ))}
        </div>
      </Card>
      {can(staff, "ticket.manage") && (
        <Card>
          <ApiForm endpoint={ep} submitLabel={t("رد", "Reply")} showResult={false} fields={[{ name: "body", label: t("الرد", "Reply"), type: "textarea", required: true, wide: true }]} extra={{ status: "IN_PROGRESS" }} />
          <div className="mt-3 flex gap-2">
            <ActionButton tone="ghost" endpoint={ep} body={{ assignToMe: true }} label={t("إسناد لي", "Assign to me")} />
            <ActionButton endpoint={ep} body={{ status: "RESOLVED" }} label={t("تم الحل", "Resolve")} />
            <ActionButton tone="ghost" endpoint={ep} body={{ status: "CLOSED" }} label={t("إغلاق", "Close")} />
          </div>
        </Card>
      )}
    </div>
  );
}
