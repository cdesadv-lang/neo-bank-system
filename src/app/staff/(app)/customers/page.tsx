import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { listCustomers } from "@/server/services/customers";
import { listBranches } from "@/server/services/admin";
import { PageTitle, Card, Table, Badge, A, Ltr } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Customers({ searchParams }: { searchParams: Promise<{ q?: string; kyc?: string }> }) {
  const { staff, lang } = await requireStaffPage("customer.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const { rows, total } = await listCustomers(staff, { q: sp.q, kycStatus: sp.kyc, take: 100 });
  const branches = await listBranches();
  return (
    <div className="space-y-5">
      <PageTitle title={t("العملاء و KYC", "Customers & KYC")} subtitle={`${total} ${t("عميل", "customers")}`} />
      <Card>
        <form className="flex flex-wrap gap-2 text-sm">
          <input name="q" defaultValue={sp.q} placeholder={t("بحث بالاسم / CIF / الرقم القومي / الموبايل", "Search name / CIF / national ID / mobile")} className="w-80 rounded border border-slate-300 px-2 py-1.5" />
          <select name="kyc" defaultValue={sp.kyc ?? ""} className="rounded border border-slate-300 px-2 py-1.5">
            <option value="">{t("كل حالات KYC", "All KYC states")}</option>
            {["PENDING", "APPROVED", "REJECTED"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("بحث", "Search")}</button>
        </form>
      </Card>
      <Card>
        <Table rows={rows} cols={[
          { h: "CIF", c: (r) => <A href={`/staff/customers/${r.id}`}><Ltr>{r.cif}</Ltr></A> },
          { h: t("الاسم", "Name"), c: (r) => <A href={`/staff/customers/${r.id}`}>{tr(lang, r.nameAr, r.nameEn)}</A> },
          { h: t("النوع", "Type"), c: (r) => r.type },
          { h: t("الموبايل", "Mobile"), c: (r) => <Ltr>{r.phone}</Ltr> },
          { h: t("الفرع", "Branch"), c: (r) => tr(lang, r.branch.nameAr, r.branch.nameEn) },
          { h: "KYC", c: (r) => <Badge v={r.kycStatus} lang={lang} /> },
          { h: t("المخاطر", "Risk"), c: (r) => <Badge v={r.riskRating} lang={lang} /> },
          { h: t("المصدر", "Source"), c: (r) => r.source },
        ]} />
      </Card>
      {can(staff, "customer.create") && (
        <Card title={t("عميل جديد (يتطلب اعتماد KYC من موظف آخر)", "New customer (KYC needs a second-person approval)")}>
          <ApiForm endpoint="/api/staff/customers" submitLabel={t("إنشاء", "Create")} fields={[
            { name: "type", label: t("النوع", "Type"), type: "select", options: [{ value: "INDIVIDUAL", label: t("فرد", "Individual") }, { value: "CORPORATE", label: t("شركة", "Corporate") }] },
            { name: "branchId", label: t("الفرع", "Branch"), type: "select", options: branches.filter((b) => !staff.branchId || b.id === staff.branchId).map((b) => ({ value: b.id, label: tr(lang, b.nameAr, b.nameEn) })) },
            { name: "nameAr", label: t("الاسم بالعربية", "Name (Arabic)"), required: true },
            { name: "nameEn", label: t("الاسم بالإنجليزية", "Name (English)"), required: true, ltr: true },
            { name: "nationalId", label: t("الرقم القومي", "National ID"), ltr: true },
            { name: "commercialRegNo", label: t("السجل التجاري (للشركات)", "Commercial reg. no. (corporate)"), ltr: true },
            { name: "phone", label: t("الموبايل", "Mobile"), required: true, placeholder: "+2010xxxxxxxx", ltr: true },
            { name: "email", label: t("البريد", "Email"), ltr: true },
            { name: "dateOfBirth", label: t("تاريخ الميلاد", "Date of birth"), type: "date" },
            { name: "occupation", label: t("المهنة", "Occupation") },
            { name: "monthlyIncome", label: t("الدخل الشهري (ج.م)", "Monthly income (EGP)"), type: "number" },
            { name: "address", label: t("العنوان", "Address"), wide: true },
          ]} />
        </Card>
      )}
    </div>
  );
}
