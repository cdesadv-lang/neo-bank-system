import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Ltr, dt } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Profile() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customer.customerId }, include: { branch: true, user: true } });
  const logins = await prisma.auditLog.findMany({ where: { actorType: "CUSTOMER", actorId: customer.customerId, action: { in: ["CUSTOMER_LOGIN", "CUSTOMER_LOGIN_FAILED"] } }, orderBy: { createdAt: "desc" }, take: 10 });
  return (
    <div className="max-w-3xl space-y-5">
      <PageTitle title={t("الملف الشخصي والأمان", "Profile & security")} />
      <Card>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-500">CIF</dt><dd><Ltr>{c.cif}</Ltr></dd>
          <dt className="text-slate-500">{t("الاسم", "Name")}</dt><dd>{tr(lang, c.nameAr, c.nameEn)}</dd>
          <dt className="text-slate-500">{t("الموبايل", "Mobile")}</dt><dd><Ltr>{c.phone}</Ltr></dd>
          <dt className="text-slate-500">{t("الفرع", "Branch")}</dt><dd>{tr(lang, c.branch.nameAr, c.branch.nameEn)}</dd>
          <dt className="text-slate-500">KYC</dt><dd>{c.kycStatus}</dd>
        </dl>
      </Card>
      <Card title={t("تحديث البيانات", "Update details")}>
        <ApiForm method="PATCH" endpoint="/api/portal/profile" submitLabel={t("حفظ", "Save")} showResult={false} resetOnSuccess={false} fields={[{ name: "email", label: t("البريد", "Email"), ltr: true, defaultValue: c.email ?? "" }, { name: "address", label: t("العنوان", "Address"), defaultValue: c.address ?? "" }]} />
      </Card>
      <Card title={t("تغيير كلمة المرور (سيتم تسجيل خروجك)", "Change password (you will be signed out)")}>
        <ApiForm endpoint="/api/portal/profile/password" submitLabel={t("تغيير", "Change")} showResult={false} onDone={{ redirect: "/portal/login" }} fields={[{ name: "current", label: t("الحالية", "Current"), type: "password", required: true }, { name: "next", label: t("الجديدة", "New"), type: "password", required: true }]} />
      </Card>
      <Card title={t("آخر عمليات الدخول", "Recent sign-ins")}>
        <ul className="text-sm">{logins.map((l) => <li key={l.id} dir="ltr">{dt(l.createdAt)} · {l.action} · {l.ip}</li>)}</ul>
      </Card>
    </div>
  );
}
