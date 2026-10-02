import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { myAccounts } from "@/server/services/portal";
import { prisma } from "@/lib/db";
import { Card, A, Ltr, money, Badge, dt, PageTitle } from "@/components/ui";
import { formatIban } from "@/lib/iban";
import { AutoRefresh } from "@/components/client";

export default async function PortalHome() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const accounts = await myAccounts(customer.customerId);
  const notes = await prisma.notification.findMany({ where: { customerId: customer.customerId }, orderBy: { createdAt: "desc" }, take: 6 });
  const holds = await prisma.cardAuthorization.aggregate({ where: { customerId: customer.customerId, status: "AUTHORIZED" }, _sum: { amount: true }, _count: true });
  const label: Record<string, [string, string]> = { CURRENT: ["حساب جاري", "Current account"], SAVINGS: ["حساب توفير", "Savings account"], TERM_DEPOSIT: ["وديعة لأجل", "Term deposit"] };
  return (
    <div className="space-y-5">
      <PageTitle title={`${t("مرحباً، ", "Welcome, ")}${tr(lang, customer.nameAr, customer.nameEn)}`} subtitle={`CIF ${customer.cif}`} actions={<AutoRefresh seconds={10} label={t("تحديث تلقائي", "Live")} />} />
      <div className="grid gap-4 md:grid-cols-3">
        {accounts.map((a) => (
          <A key={a.id} href={`/portal/accounts/${a.id}`}>
            <div className="rounded-2xl bg-gradient-to-br from-sky-700 to-sky-900 p-5 text-white shadow hover:opacity-95">
              <div className="flex items-center justify-between text-sm"><span>{tr(lang, ...(label[a.type] ?? [a.type, a.type]))}{a.nickname ? ` · ${a.nickname}` : ""}</span>{a.status !== "ACTIVE" && <Badge v={a.status} lang={lang} />}</div>
              <div className="mt-3 text-2xl font-bold" dir="ltr">{money(a.balance, a.currency)}</div>
              <div className="mt-2 text-xs text-sky-100" dir="ltr">{formatIban(a.accountNumber)}</div>
            </div>
          </A>
        ))}
      </div>
      {holds._count > 0 && <p className="text-sm text-amber-800">{t("مبالغ محجوزة لعمليات بطاقات لم تتم تسويتها", "Amounts on hold for pending card transactions")}: <Ltr>{money(holds._sum.amount ?? 0n)}</Ltr> ({holds._count})</p>}
      <Card title={t("آخر الإشعارات", "Latest notifications")} actions={<A href="/portal/notifications">{t("الكل", "All")}</A>}>
        <ul className="divide-y divide-slate-100 text-sm">
          {notes.map((n) => <li key={n.id} className="py-2"><div className="font-medium">{tr(lang, n.titleAr, n.titleEn)} {!n.read && <span className="ms-1 inline-block h-2 w-2 rounded-full bg-rose-500" />}</div><div className="text-slate-600">{tr(lang, n.bodyAr, n.bodyEn)}</div><div className="text-xs text-slate-400">{dt(n.createdAt)}</div></li>)}
        </ul>
      </Card>
    </div>
  );
}
