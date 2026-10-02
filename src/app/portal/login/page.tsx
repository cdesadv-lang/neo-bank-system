import Link from "next/link";
import { getLang } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { PortalLoginForm } from "@/components/auth-forms";
import { LangToggle } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function PortalLogin() {
  const lang = await getLang();
  const t = (a: string, e: string) => tr(lang, a, e);
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-sky-800 to-slate-900 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">{t("نيو بنك أونلاين", "Neo Bank Online")}</h1>
          <span className="rounded bg-sky-900 p-0.5 text-white"><LangToggle lang={lang} /></span>
        </div>
        <PortalLoginForm t={{ username: t("اسم المستخدم", "Username"), password: t("كلمة المرور", "Password"), next: t("متابعة", "Continue"), otpSent: t("أرسلنا رمز تحقق إلى", "We sent a verification code to"), code: t("رمز التحقق", "Verification code"), login: t("دخول", "Sign in") }} />
        <p className="mt-4 text-center text-sm"><Link href="/portal/onboarding" className="text-sky-700 hover:underline">{t("عميل جديد؟ افتح حسابك رقمياً", "New customer? Open an account online")}</Link></p>
        <p className="mt-3 text-xs text-slate-500">{t("لن يطلب منك البنك أبداً رمز التحقق أو كلمة المرور عبر الهاتف.", "The bank will never ask for your OTP or password by phone.")}</p>
      </div>
    </main>
  );
}
