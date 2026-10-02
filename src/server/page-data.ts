import "server-only";
import { prisma } from "@/lib/db";
import type { StaffPrincipal } from "@/server/rbac";
import { branchWhere } from "@/server/rbac";

export async function deviceOptions(staff: StaffPrincipal) {
  const d = await prisma.cashCounterDevice.findMany({ where: { ...branchWhere(staff), status: "ONLINE" }, orderBy: { deviceId: "asc" } });
  return d.map((x) => ({ deviceId: x.deviceId, label: `${x.deviceId} · ${x.model} · ${x.driver}` }));
}

export function countLabels(t: (a: string, e: string) => string) {
  return {
    device: t("الجهاز", "Device"), simNotes: t("محاكاة الفئات (اختياري)", "Simulated notes (optional)"), counterfeits: t("مزيف", "Counterfeit"),
    pull: t("سحب العدّ من الماكينة", "Pull count from device"), noDevice: t("لا توجد ماكينة عد متصلة بالفرع", "No online cash counter in this branch"),
    account: t("الحساب (IBAN)", "Account (IBAN)"), amount: t("المبلغ", "Amount"), narrative: t("البيان", "Narrative"), submit: t("تنفيذ", "Post"),
    pending: t("تم إرسال العملية للموافقة (مبلغ كبير)", "Sent for approval (large cash)"), done: t("تم الترحيل", "Posted"),
    bound: t("المبلغ مأخوذ من عدّ الماكينة وسيتم ربطه بالعملية", "Amount taken from the device count and bound to this operation"),
    counted: t("المبلغ المعدود", "Counted cash"), balance: t("موازنة وإقفال الخزينة", "Balance & close till"), variance: t("الفرق", "Variance"),
    confirmClose: t("سيتم إقفال الخزينة وترحيل أي فرق. متابعة؟", "The till will be closed and any variance posted. Continue?"),
  };
}
