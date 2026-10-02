import { getLang } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { OnboardingForm } from "@/components/auth-forms";
import { listBranches } from "@/server/services/admin";

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const lang = await getLang();
  const t = (a: string, e: string) => tr(lang, a, e);
  const branches = await listBranches();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-bold">{t("فتح حساب رقمي", "Digital onboarding")}</h1>
      <p className="mb-4 text-sm text-slate-500">{t("سيتم إنشاء ملفك وحسابك بحالة (قيد المراجعة) حتى يعتمد موظف الامتثال بيانات KYC.", "Your profile and account are created as PENDING until a compliance officer approves KYC.")}</p>
      <div className="rounded-xl bg-white p-5 shadow">
        <OnboardingForm branches={branches.map((b) => ({ code: b.code, name: tr(lang, b.nameAr, b.nameEn) }))} t={{
          nameAr: t("الاسم بالعربية", "Name (Arabic)"), nameEn: t("الاسم بالإنجليزية", "Name (English)"), nationalId: t("الرقم القومي (14 رقم)", "National ID (14 digits)"),
          phone: t("الموبايل", "Mobile"), email: t("البريد الإلكتروني", "Email"), dob: t("تاريخ الميلاد", "Date of birth"), address: t("العنوان", "Address"), branch: t("الفرع", "Branch"),
          currency: t("عملة الحساب", "Account currency"), username: t("اسم المستخدم", "Username"), password: t("كلمة المرور", "Password"),
          pwHint: t("10 أحرف على الأقل تشمل حروفاً كبيرة وصغيرة ورقماً ورمزاً", "At least 10 chars incl. upper, lower, digit and symbol"), next: t("إرسال رمز التحقق", "Send verification code"),
          otpSent: t("أدخل الرمز المرسل إلى", "Enter the code sent to"), confirm: t("تأكيد", "Confirm"), onboarded: t("تم استلام طلبك. يمكنك الدخول بعد اعتماد البنك.", "Application received. You can sign in; services unlock after bank approval."),
        }} />
      </div>
    </main>
  );
}
