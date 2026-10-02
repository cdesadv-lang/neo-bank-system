import Link from "next/link";
import { requireCustomerPage } from "@/server/page-auth";
import { NAV_PORTAL, tr } from "@/lib/i18n";
import { LangToggle, LogoutButton } from "@/components/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { customer, lang } = await requireCustomerPage();
  const unread = await prisma.notification.count({ where: { customerId: customer.customerId, read: false } });
  return (
    <div className="min-h-screen">
      <header className="no-print bg-gradient-to-l from-sky-800 to-sky-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/portal" className="text-lg font-bold">{tr(lang, "نيو بنك أونلاين", "Neo Bank Online")}</Link>
          <div className="flex items-center gap-2 text-sm">
            <span>{tr(lang, customer.nameAr, customer.nameEn)}</span>
            <LangToggle lang={lang} />
            <LogoutButton endpoint="/api/portal/auth/logout" redirect="/portal/login" label={tr(lang, "خروج", "Logout")} />
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 px-3 pb-2 text-sm">
          {NAV_PORTAL.map((n) => (
            <Link key={n.href} href={n.href} className="rounded px-3 py-1 hover:bg-white/10">
              {tr(lang, n.ar, n.en)}{n.href === "/portal/notifications" && unread > 0 && <span className="ms-1 rounded-full bg-rose-500 px-1.5 text-xs">{unread}</span>}
            </Link>
          ))}
        </nav>
      </header>
      {customer.kycStatus !== "APPROVED" && <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">{tr(lang, "ملفك قيد المراجعة من البنك؛ بعض الخدمات غير متاحة حتى اعتماد KYC.", "Your profile is under review; some services are unavailable until KYC is approved.")}</div>}
      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  );
}
