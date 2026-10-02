import Link from "next/link";
import { requireStaffPage } from "@/server/page-auth";
import { NAV_STAFF, tr } from "@/lib/i18n";
import { can, type Permission } from "@/server/rbac";
import { LangToggle, LogoutButton } from "@/components/client";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const { staff, lang } = await requireStaffPage();
  const branch = staff.branchId ? await prisma.branch.findUnique({ where: { id: staff.branchId } }) : null;
  const nav = NAV_STAFF.filter((n) => !n.perm || can(staff, n.perm as Permission));
  return (
    <div className="flex min-h-screen">
      <nav className="no-print w-60 shrink-0 bg-slate-900 text-slate-200">
        <div className="border-b border-white/10 px-4 py-4">
          <Link href="/staff" className="text-lg font-bold text-white">{tr(lang, "نيو بنك — الأنظمة", "Neo Bank Core")}</Link>
          <div className="mt-1 text-xs text-slate-400">{tr(lang, "بيئة تجريبية", "Demo environment")}</div>
        </div>
        <ul className="space-y-0.5 p-2 text-sm">
          {nav.map((n) => <li key={n.href}><Link href={n.href} className="block rounded px-3 py-1.5 hover:bg-white/10">{tr(lang, n.ar, n.en)}</Link></li>)}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center justify-between gap-3 bg-sky-900 px-5 py-2.5 text-sm text-white">
          <div>
            <b>{tr(lang, staff.fullNameAr, staff.fullNameEn)}</b> · <span className="text-sky-200">{staff.role}</span>
            {branch ? <> · <span className="text-sky-200">{tr(lang, branch.nameAr, branch.nameEn)}</span></> : <> · <span className="text-sky-200">{tr(lang, "المركز الرئيسي", "Head office")}</span></>}
          </div>
          <div className="flex items-center gap-2">
            <LangToggle lang={lang} />
            <LogoutButton endpoint="/api/staff/auth/logout" redirect="/staff/login" label={tr(lang, "خروج", "Logout")} />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
