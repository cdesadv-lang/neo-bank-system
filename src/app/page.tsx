import Link from "next/link";
import { getLang } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { LangToggle } from "@/components/client";

export default async function Home() {
  const lang = await getLang();
  const t = (a: string, e: string) => tr(lang, a, e);
  return (
    <main className="min-h-screen bg-gradient-to-br from-sky-900 to-slate-900 text-white">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">{t("نيو بنك", "Neo Bank")}</h1>
          <LangToggle lang={lang} />
        </div>
        <p className="mt-3 text-sky-100">{t("نظام بنكي أساسي وبوابة رقمية للعملاء — بيانات وهمية لأغراض العرض.", "Core banking system and customer digital portal — fictional demo data.")}</p>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Link href="/staff" className="rounded-2xl bg-white/10 p-6 hover:bg-white/20">
            <div className="text-xl font-semibold">{t("النظام البنكي الأساسي (الموظفون)", "Core Banking (staff)")}</div>
            <p className="mt-2 text-sm text-sky-100">{t("العملاء، الحسابات، الصراف، التحويلات، القروض، البطاقات، الصراف الآلي، مكافحة غسل الأموال، التقارير وإقفال اليوم.", "Customers, accounts, teller, transfers, loans, cards, ATMs, AML, reports and EOD.")}</p>
          </Link>
          <Link href="/portal" className="rounded-2xl bg-white/10 p-6 hover:bg-white/20">
            <div className="text-xl font-semibold">{t("البوابة الرقمية للعملاء", "Digital Banking Portal")}</div>
            <p className="mt-2 text-sm text-sky-100">{t("الحسابات، التحويلات برمز التحقق، الفواتير، البطاقات وإعداداتها، القروض والودائع.", "Accounts, OTP-confirmed transfers, bills, cards and channel controls, loans and deposits.")}</p>
          </Link>
        </div>
        <p className="mt-10 text-xs text-sky-200">{t("تنبيه: هذا نظام تجريبي. التشغيل الفعلي يتطلب ترخيص البنك المركزي المصري وشهادة PCI-DSS وربطاً معتمداً بشبكات الدفع.", "Notice: demo system. Going live requires a Central Bank of Egypt licence, PCI-DSS certification and certified payment-network integration.")}</p>
      </div>
    </main>
  );
}
