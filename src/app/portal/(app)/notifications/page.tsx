import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, dt } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client";

export default async function Notifications() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const notes = await prisma.notification.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("الإشعارات", "Notifications")} actions={<><AutoRefresh label={t("تحديث تلقائي", "Live")} /><ActionButton tone="ghost" endpoint="/api/portal/notifications" body={{ all: true }} label={t("تحديد الكل كمقروء", "Mark all read")} /></>} />
      <Card>
        <ul className="divide-y divide-slate-100 text-sm">
          {notes.map((n) => <li key={n.id} className={`py-2 ${n.read ? "" : "bg-sky-50/50"}`}><div className="font-medium">{tr(lang, n.titleAr, n.titleEn)}</div><div className="text-slate-600">{tr(lang, n.bodyAr, n.bodyEn)}</div><div className="text-xs text-slate-400">{dt(n.createdAt)}</div></li>)}
        </ul>
      </Card>
    </div>
  );
}
