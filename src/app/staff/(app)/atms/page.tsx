import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { listAtms } from "@/server/services/atm";
import { listBranches } from "@/server/services/admin";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Notice } from "@/components/ui";
import { ApiForm, ActionButton, AutoRefresh } from "@/components/client";
import { AtmSimulatorForm } from "@/components/simulators";

export default async function Atms() {
  const { staff, lang } = await requireStaffPage("atm.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const atms = await listAtms(staff);
  const branches = (await listBranches()).filter((b) => !staff.branchId || b.id === staff.branchId);
  const manage = can(staff, "atm.manage");
  const cards = manage ? await prisma.card.findMany({ where: { account: branchWhere(staff), status: { in: ["ACTIVE", "FROZEN"] } }, include: { customer: true }, take: 100, orderBy: { createdAt: "asc" } }) : [];
  const recent = await prisma.cardAuthorization.findMany({ where: { channel: "ATM", terminalId: { in: atms.map((a) => a.terminalId) } }, orderBy: { createdAt: "desc" }, take: 25 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("أجهزة الصراف الآلي", "ATMs")} actions={<AutoRefresh label={t("تحديث تلقائي", "Live")} />} />
      <Notice>{t("المحاكي ومحوّل ISO 8583 مدمجان لأغراض العرض. التشغيل الفعلي يتطلب سويتش/معالج مدفوعات (بروتوكول NDC/DDC مع مورد الأجهزة)، ووحدة HSM معتمدة، واعتماد الشبكة (ميزة / Visa / Mastercard).", "Simulator and ISO 8583 adapter are built in for demo. Production needs a switch/processor (NDC/DDC with the ATM vendor), a certified HSM and network certification (Meeza / Visa / Mastercard).")}</Notice>
      {atms.map((a) => {
        const variance = a.cassetteBalance - a.till.balance;
        return (
          <Card key={a.id} title={`${a.terminalId} — ${tr(lang, a.locationAr, a.locationEn)}`} actions={<Badge v={a.status} lang={lang} />}>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="text-sm">
                <div>{t("الرصيد الدفتري", "Ledger cash")}: <Ltr>{money(a.till.balance)}</Ltr></div>
                <div>{t("حسب العدادات", "Per cassettes")}: <Ltr>{money(a.cassetteBalance)}</Ltr></div>
                <div className={variance === 0n ? "text-emerald-700" : "font-bold text-rose-700"}>{t("الفرق", "Difference")}: <Ltr>{money(variance)}</Ltr></div>
                <div className="text-xs text-slate-500">{t("آخر تغذية", "Last replenished")}: {dt(a.lastReplenishedAt)}</div>
                <div className="text-xs text-slate-500">{t("حد السحب للعملية", "Per-txn max")}: <Ltr>{money(a.maxWithdrawal)}</Ltr></div>
              </div>
              <Table rows={a.cassettes} cols={[{ h: t("الكاسيت", "Cassette"), c: (c) => c.position }, { h: t("الفئة", "Note"), c: (c) => <Ltr>{money(c.denomination, "")}</Ltr> }, { h: t("العدد", "Count"), c: (c) => c.count }, { h: t("القيمة", "Value"), c: (c) => <Ltr>{money(c.denomination * BigInt(c.count), "")}</Ltr> }]} />
              <Table rows={a.reconciliations} empty={t("لا توجد مطابقات", "No reconciliations")} cols={[{ h: t("النوع", "Kind"), c: (r) => r.kind }, { h: t("الفرق", "Variance"), c: (r) => <Ltr>{money(r.variance, "")}</Ltr> }, { h: t("الوقت", "Time"), c: (r) => dt(r.createdAt) }]} />
            </div>
            {manage && (
              <div className="mt-4 grid gap-4 border-t border-slate-100 pt-3 md:grid-cols-3">
                <div>
                  <div className="mb-1 text-xs font-semibold">{t("تغذية من الخزينة الرئيسية (عدد الأوراق لكل كاسيت)", "Replenish from vault (notes per cassette)")}</div>
                  <ApiForm idempotent endpoint={`/api/staff/atms/${a.id}`} extra={{ action: "REPLENISH" }} submitLabel={t("تغذية", "Replenish")} showResult={false} fields={[
                    { name: "cassettes", label: "JSON", type: "json", defaultValue: JSON.stringify(a.cassettes.map((c) => ({ position: c.position, notes: 200 }))) }]} />
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold">{t("مطابقة نهاية اليوم (العدّ الفعلي)", "EOD reconciliation (physical count)")}</div>
                  <ApiForm endpoint={`/api/staff/atms/${a.id}`} extra={{ action: "RECONCILE" }} submitLabel={t("مطابقة", "Reconcile")} showResult={false} confirm={t("سيتم ترحيل أي فرق إلى حساب العجز والزيادة. متابعة؟", "Any variance will post to cash over/short. Continue?")} fields={[
                    { name: "counted", label: "JSON", type: "json", defaultValue: JSON.stringify(a.cassettes.map((c) => ({ position: c.position, notes: c.count }))) }]} />
                </div>
                <div className="flex flex-wrap items-start gap-1">
                  {["ONLINE", "OFFLINE", "MAINTENANCE"].filter((s) => s !== a.status).map((s) => <ActionButton key={s} tone="ghost" endpoint={`/api/staff/atms/${a.id}`} body={{ action: "STATUS", status: s }} label={s} />)}
                </div>
              </div>
            )}
          </Card>
        );
      })}
      {manage && atms.length > 0 && cards.length > 0 && (
        <Card title={t("محاكي الصراف الآلي (ISO 8583)", "ATM simulator (ISO 8583)")}>
          <AtmSimulatorForm atms={atms.map((a) => ({ value: a.terminalId, label: `${a.terminalId} · ${tr(lang, a.locationAr, a.locationEn)}` }))} cards={cards.map((c) => ({ value: c.id, label: `${c.maskedPan} · ${tr(lang, c.customer.nameAr, c.customer.nameEn)} · ${c.status}` }))}
            t={{ atm: t("الجهاز", "ATM"), card: t("البطاقة", "Card"), op: t("العملية", "Operation"), withdraw: t("سحب", "Withdrawal"), balance: t("استعلام رصيد", "Balance inquiry"), mini: t("كشف مصغر", "Mini statement"), fault: t("سحب مع عطل صرف (عكس)", "Withdrawal + dispense fault (reversal)"), timeout: t("سحب مع انتهاء مهلة السويتش (عكس تلقائي)", "Withdrawal + switch timeout (auto-reversal)"), amount: t("المبلغ", "Amount"), send: t("تنفيذ", "Run") }} />
        </Card>
      )}
      <Card title={t("آخر عمليات الصراف", "Recent ATM transactions")}>
        <Table rows={recent} cols={[{ h: t("الوقت", "Time"), c: (r) => dt(r.createdAt) }, { h: t("الجهاز", "ATM"), c: (r) => <Ltr>{r.terminalId}</Ltr> }, { h: t("النوع", "Type"), c: (r) => r.txnType }, { h: t("المبلغ", "Amount"), c: (r) => <Ltr>{money(r.amount, r.currency)}</Ltr> }, { h: "RC", c: (r) => r.responseCode }, { h: "", c: (r) => <Badge v={r.status} lang={lang} /> }]} />
      </Card>
      {manage && (
        <Card title={t("تعريف جهاز صراف جديد", "Register a new ATM")}>
          <ApiForm endpoint="/api/staff/atms" submitLabel={t("إضافة", "Add")} fields={[
            { name: "terminalId", label: t("رقم الجهاز (8 خانات)", "Terminal id (8 chars)"), required: true, ltr: true, placeholder: "NBCAI002" },
            { name: "branchId", label: t("الفرع", "Branch"), type: "select", options: branches.map((b) => ({ value: b.id, label: tr(lang, b.nameAr, b.nameEn) })) },
            { name: "locationAr", label: t("الموقع (عربي)", "Location (Arabic)"), required: true }, { name: "locationEn", label: t("الموقع (إنجليزي)", "Location (English)"), required: true }]} />
        </Card>
      )}
    </div>
  );
}
