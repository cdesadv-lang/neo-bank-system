import { redirect } from "next/navigation";
import { getLang, getStaffOptional } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { StaffLoginForm } from "@/components/auth-forms";
import { LangToggle } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function StaffLogin() {
  if (await getStaffOptional()) redirect("/staff");
  const lang = await getLang();
  const t = (a: string, e: string) => tr(lang, a, e);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">{t("دخول الموظفين", "Staff sign-in")}</h1>
          <span className="rounded bg-slate-800 p-0.5"><LangToggle lang={lang} /></span>
        </div>
        <StaffLoginForm t={{ username: t("اسم المستخدم", "Username"), password: t("كلمة المرور", "Password"), totp: t("رمز المصادقة الثنائية", "2FA code"), login: t("دخول", "Sign in") }} />
        <p className="mt-4 text-xs text-slate-500">{t("يتم قفل الحساب بعد 5 محاولات فاشلة لمدة 15 دقيقة.", "Accounts lock for 15 minutes after 5 failed attempts.")}</p>
      </div>
    </main>
  );
}
