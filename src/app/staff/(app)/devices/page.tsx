import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { listDevices } from "@/server/services/cash-count";
import { listBranches } from "@/server/services/admin";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Notice } from "@/components/ui";
import { ApiForm } from "@/components/client";

export default async function Devices() {
  const { staff, lang } = await requireStaffPage("till.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const devices = await listDevices(staff);
  const branches = (await listBranches()).filter((b) => !staff.branchId || b.id === staff.branchId);
  return (
    <div className="space-y-5">
      <PageTitle title={t("ماكينات عد وفحص النقدية", "Cash counting machines")} />
      <Notice tone="sky">{t("برنامج تشغيل المحاكاة مدمج. برنامج TCP يقرأ إطاراً نصياً عاماً (CUR=EGP;D20000=5;CF=0;SN=...). برامج التشغيل التسلسلية/USB تعتمد على طراز الماكينة (Glory / Kisan / Magner…) ويجب تطويرها مع المورّد.", "A simulator driver is built in. The TCP driver reads a generic text frame (CUR=EGP;D20000=5;CF=0;SN=...). Serial/USB drivers depend on the machine model (Glory / Kisan / Magner…) and must be built with the vendor's protocol.")}</Notice>
      <Card>
        <Table rows={devices} cols={[
          { h: t("الجهاز", "Device"), c: (d) => <Ltr>{d.deviceId}</Ltr> }, { h: t("الطراز", "Model"), c: (d) => d.model }, { h: t("برنامج التشغيل", "Driver"), c: (d) => d.driver },
          { h: t("العنوان", "Address"), c: (d) => <Ltr>{d.address ?? "—"}</Ltr> }, { h: t("الحالة", "Status"), c: (d) => <Badge v={d.status} lang={lang} /> },
          { h: t("آخر العدّات", "Recent counts"), c: (d) => <div className="space-y-0.5 text-xs">{d.sessions.map((s) => <div key={s.id} dir="ltr">{dt(s.createdAt)} · {s.purpose} · {money(s.total, s.currency)}{s.suspectedCounterfeits ? ` · ⚠${s.suspectedCounterfeits}` : ""}{s.usedAt ? " · used" : ""}</div>)}</div> },
        ]} />
      </Card>
      {can(staff, "till.manage") && (
        <Card title={t("تسجيل ماكينة", "Register a device")}>
          <ApiForm endpoint="/api/staff/devices" submitLabel={t("تسجيل", "Register")} fields={[
            { name: "deviceId", label: t("المعرّف", "Device id"), required: true, placeholder: "CNT-0101-02", ltr: true },
            { name: "branchId", label: t("الفرع", "Branch"), type: "select", options: branches.map((b) => ({ value: b.id, label: tr(lang, b.nameAr, b.nameEn) })) },
            { name: "model", label: t("الطراز", "Model"), required: true }, { name: "driver", label: t("برنامج التشغيل", "Driver"), type: "select", options: ["SIMULATOR", "TCP", "SERIAL", "USB"].map((v) => ({ value: v, label: v })) },
            { name: "address", label: t("العنوان (host:port أو /dev/ttyUSB0)", "Address (host:port or /dev/ttyUSB0)"), ltr: true }]} />
        </Card>
      )}
    </div>
  );
}
