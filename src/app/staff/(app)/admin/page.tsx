import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, ROLE_PERMISSIONS, PERMISSIONS, BRANCH_SCOPED_ROLES } from "@/server/rbac";
import { listStaff, listBranches } from "@/server/services/admin";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, dt, money } from "@/components/ui";
import { ApiForm, ActionButton, Tabs } from "@/components/client";

const ROLES = Object.keys(ROLE_PERMISSIONS);

export default async function Admin() {
  const { staff, lang } = await requireStaffPage("staff.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const people = await listStaff(staff);
  const branches = await listBranches();
  const fees = await prisma.feeRule.findMany({ orderBy: { code: "asc" } });
  const m = can(staff, "staff.manage");
  const staffTab = (
    <div className="space-y-4">
      <Card>
        <Table rows={people} cols={[
          { h: t("المستخدم", "User"), c: (p) => <Ltr>{p.username}</Ltr> }, { h: t("الاسم", "Name"), c: (p) => tr(lang, p.fullNameAr, p.fullNameEn) }, { h: t("الدور", "Role"), c: (p) => p.role },
          { h: t("الفرع", "Branch"), c: (p) => (p.branch ? tr(lang, p.branch.nameAr, p.branch.nameEn) : t("المركز الرئيسي", "Head office")) }, { h: "2FA", c: (p) => (p.totpEnabled ? "✓" : "—") },
          { h: t("آخر دخول", "Last login"), c: (p) => dt(p.lastLoginAt) }, { h: t("الحالة", "Status"), c: (p) => <span><Badge v={p.active ? "ACTIVE" : "CLOSED"} lang={lang} />{p.lockedUntil && p.lockedUntil > new Date() && <span className="ms-1 text-xs text-rose-700">{t("مقفل", "locked")}</span>}</span> },
          { h: "", c: (p) => m && p.id !== staff.id ? <div className="flex gap-1">
            {p.lockedUntil && p.lockedUntil > new Date() && <ActionButton tone="ghost" method="PATCH" endpoint={`/api/staff/staff/${p.id}`} body={{ unlock: true }} label={t("فك القفل", "Unlock")} />}
            <ActionButton tone={p.active ? "danger" : "ghost"} method="PATCH" endpoint={`/api/staff/staff/${p.id}`} body={{ active: !p.active }} label={p.active ? t("تعطيل", "Disable") : t("تفعيل", "Enable")} />
          </div> : null },
        ]} />
      </Card>
      {m && <Card title={t("موظف جديد", "New staff user")}>
        <ApiForm endpoint="/api/staff/staff" submitLabel={t("إنشاء", "Create")} fields={[
          { name: "username", label: t("اسم المستخدم", "Username"), required: true, ltr: true }, { name: "email", label: t("البريد", "Email"), required: true, ltr: true },
          { name: "fullNameAr", label: t("الاسم بالعربية", "Name (Arabic)"), required: true }, { name: "fullNameEn", label: t("الاسم بالإنجليزية", "Name (English)"), required: true },
          { name: "role", label: t("الدور", "Role"), type: "select", options: ROLES.map((r) => ({ value: r, label: r })) },
          { name: "branchId", label: t("الفرع", "Branch"), type: "select", options: [{ value: "", label: t("المركز الرئيسي", "Head office") }, ...branches.map((b) => ({ value: b.id, label: tr(lang, b.nameAr, b.nameEn) }))] },
          { name: "password", label: t("كلمة مرور مؤقتة", "Temporary password"), type: "password", required: true }]} />
      </Card>}
    </div>
  );
  const matrix = (
    <Card title={t("مصفوفة الصلاحيات", "Permission matrix")}>
      <p className="mb-2 text-xs text-slate-500">{t("الأدوار المقيدة بالفرع:", "Branch-scoped roles:")} {BRANCH_SCOPED_ROLES.join(", ")}</p>
      <div className="overflow-x-auto"><table className="text-xs" dir="ltr"><thead><tr><th className="p-1 text-left">permission</th>{ROLES.map((r) => <th key={r} className="p-1 [writing-mode:vertical-rl]">{r}</th>)}</tr></thead>
        <tbody>{PERMISSIONS.map((p) => <tr key={p} className="border-t border-slate-100"><td className="p-1 font-mono">{p}</td>{ROLES.map((r) => <td key={r} className="p-1 text-center">{(ROLE_PERMISSIONS as Record<string, readonly string[]>)[r].includes(p) ? "●" : ""}</td>)}</tr>)}</tbody></table></div>
    </Card>
  );
  const branchTab = (
    <div className="space-y-4">
      <Card><Table rows={branches} cols={[{ h: t("الكود", "Code"), c: (b) => <Ltr>{b.code}</Ltr> }, { h: t("الاسم", "Name"), c: (b) => tr(lang, b.nameAr, b.nameEn) }, { h: t("المدينة", "City"), c: (b) => b.city }, { h: t("العملاء", "Customers"), c: (b) => b._count.customers }, { h: t("الحسابات", "Accounts"), c: (b) => b._count.accounts }, { h: t("الموظفون", "Staff"), c: (b) => b._count.staff }]} /></Card>
      {can(staff, "branch.manage") && <Card title={t("فرع جديد", "New branch")}><ApiForm endpoint="/api/staff/branches" submitLabel={t("إنشاء", "Create")} fields={[{ name: "code", label: t("الكود (4 أرقام)", "Code (4 digits)"), required: true, ltr: true }, { name: "city", label: t("المدينة", "City"), required: true }, { name: "nameAr", label: t("الاسم بالعربية", "Name (Arabic)"), required: true }, { name: "nameEn", label: t("الاسم بالإنجليزية", "Name (English)"), required: true }, { name: "address", label: t("العنوان", "Address"), wide: true }]} /></Card>}
    </div>
  );
  const feeTab = (
    <Card title={t("قواعد الرسوم", "Fee rules")}>
      <Table rows={fees} cols={[{ h: t("الكود", "Code"), c: (f) => <Ltr>{f.code}</Ltr> }, { h: t("الاسم", "Name"), c: (f) => tr(lang, f.nameAr, f.nameEn) }, { h: t("الحدث", "Event"), c: (f) => <Ltr>{f.event}</Ltr> }, { h: t("ثابت", "Fixed"), c: (f) => <Ltr>{money(f.fixedAmount, "")}</Ltr> }, { h: t("نسبة", "Rate"), c: (f) => `${f.rateBps / 100}%` }, { h: t("أدنى/أقصى", "Min/Max"), c: (f) => <Ltr>{money(f.minAmount, "")} / {f.maxAmount !== null ? money(f.maxAmount, "") : "—"}</Ltr> }, { h: "", c: (f) => (f.active ? "✓" : "✗") },
        { h: "", c: (f) => can(staff, "fee.manage") ? <ActionButton tone="ghost" method="PATCH" endpoint="/api/staff/fees" body={{ id: f.id }} prompt={{ field: "fixedAmount", label: t("الرسم الثابت الجديد", "New fixed fee") }} label={t("تعديل", "Edit")} /> : null }]} />
    </Card>
  );
  return (
    <div className="space-y-5">
      <PageTitle title={t("الموظفون والفروع والإعدادات", "Staff, branches & settings")} />
      <Tabs tabs={[{ id: "s", label: t("الموظفون", "Staff"), content: staffTab }, { id: "m", label: t("الصلاحيات", "Permissions"), content: matrix }, { id: "b", label: t("الفروع", "Branches"), content: branchTab }, { id: "f", label: t("الرسوم", "Fees"), content: feeTab }]} />
    </div>
  );
}
