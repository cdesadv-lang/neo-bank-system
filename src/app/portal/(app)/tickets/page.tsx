import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Badge, dt, Ltr } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function PortalTickets() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const tickets = await prisma.supportTicket.findMany({ where: { customerId: customer.customerId }, include: { messages: { orderBy: { createdAt: "asc" } } }, orderBy: { updatedAt: "desc" } });
  return (
    <div className="space-y-5">
      <PageTitle title={t("الدعم والشكاوى", "Support & complaints")} />
      <Card title={t("طلب جديد", "New request")}>
        <ApiForm endpoint="/api/portal/tickets" submitLabel={t("إرسال", "Send")} showResult={false} fields={[
          { name: "subject", label: t("الموضوع", "Subject"), required: true },
          { name: "category", label: t("التصنيف", "Category"), type: "select", options: ["GENERAL", "CARDS", "TRANSFERS", "LOANS", "ACCOUNTS", "COMPLAINT"].map((c) => ({ value: c, label: c })) },
          { name: "body", label: t("التفاصيل", "Details"), type: "textarea", required: true, wide: true }]} />
      </Card>
      {tickets.map((x) => (
        <Card key={x.id} title={`${x.subject}`} actions={<span className="flex items-center gap-2 text-xs"><Ltr>{x.ticketNo}</Ltr><Badge v={x.status} lang={lang} /></span>}>
          <div className="space-y-2">
            {x.messages.map((m) => <div key={m.id} className={`rounded p-2 text-sm ${m.authorType === "STAFF" ? "bg-sky-50" : "bg-slate-100"}`}><div className="text-xs text-slate-500">{m.authorType === "STAFF" ? t("البنك", "Bank") : t("أنت", "You")} · {dt(m.createdAt)}</div><div className="whitespace-pre-wrap">{m.body}</div></div>)}
          </div>
          {x.status !== "CLOSED" && <div className="mt-2"><ApiForm compact endpoint={`/api/portal/tickets/${x.id}`} submitLabel={t("رد", "Reply")} showResult={false} fields={[{ name: "body", label: "", required: true }]} /></div>}
        </Card>
      ))}
    </div>
  );
}
