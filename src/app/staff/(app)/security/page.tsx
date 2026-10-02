import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Notice } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Security() {
  const { staff, lang } = await requireStaffPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const me = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } });
  return (
    <div className="max-w-2xl space-y-5">
      <PageTitle title={t("الأمان", "Security")} />
      <Card title={t("تغيير كلمة المرور", "Change password")}>
        <ApiForm endpoint="/api/staff/auth/password" submitLabel={t("تغيير", "Change")} showResult={false} fields={[{ name: "current", label: t("الحالية", "Current"), type: "password", required: true }, { name: "next", label: t("الجديدة (10+ أحرف، كبيرة وصغيرة ورقم ورمز)", "New (10+ chars, upper/lower/digit/symbol)"), type: "password", required: true }]} />
      </Card>
      <Card title={t("المصادقة الثنائية (TOTP)", "Two-factor authentication (TOTP)")}>
        {me.totpEnabled ? (
          <>
            <Notice tone="sky">{t("المصادقة الثنائية مفعلة.", "2FA is enabled.")}</Notice>
            <div className="mt-3"><ApiForm compact endpoint="/api/staff/auth/totp" extra={{ action: "DISABLE" }} submitLabel={t("تعطيل", "Disable")} showResult={false} fields={[{ name: "code", label: t("الرمز الحالي", "Current code"), required: true, ltr: true }]} /></div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">{t("1) أنشئ مفتاحاً وأضفه إلى تطبيق المصادقة (Google Authenticator / Microsoft Authenticator). 2) أدخل الرمز لتفعيله.", "1) Generate a secret and add it to your authenticator app. 2) Enter a code to enable.")}</p>
            <ApiForm endpoint="/api/staff/auth/totp" extra={{ action: "SETUP" }} submitLabel={t("إنشاء مفتاح", "Generate secret")} fields={[]} onDone="none" />
            <ApiForm compact endpoint="/api/staff/auth/totp" extra={{ action: "ENABLE" }} submitLabel={t("تفعيل", "Enable")} showResult={false} fields={[{ name: "code", label: t("الرمز", "Code"), required: true, ltr: true }]} />
          </div>
        )}
      </Card>
    </div>
  );
}
