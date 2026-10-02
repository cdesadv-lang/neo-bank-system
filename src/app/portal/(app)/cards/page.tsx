import { requireCustomerPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { prisma } from "@/lib/db";
import { minorToString } from "@/lib/money";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Notice } from "@/components/ui";
import { ApiForm, ActionButton, AutoRefresh } from "@/components/client";
import { DemoCheckout } from "@/components/simulators";

export default async function PortalCards() {
  const { customer, lang } = await requireCustomerPage();
  const t = (a: string, e: string) => tr(lang, a, e);
  const cards = await prisma.card.findMany({ where: { customerId: customer.customerId, status: { not: "CANCELLED" } }, include: { account: true }, omit: { token: true, pinVerificationValue: true }, orderBy: { createdAt: "asc" } });
  const txns = await prisma.cardAuthorization.findMany({ where: { customerId: customer.customerId }, include: { disputes: true }, orderBy: { createdAt: "desc" }, take: 60 });
  const chLabel: Record<string, string> = { ATM: t("صراف آلي", "ATM"), POS: t("نقطة بيع", "POS"), ECOM: t("إنترنت", "Online"), CONTACTLESS: t("لا تلامسي", "Contactless") };
  return (
    <div className="space-y-5">
      <PageTitle title={t("البطاقات", "Cards")} actions={<AutoRefresh label={t("تحديث تلقائي", "Live")} />} />
      {cards.length === 0 && <Notice>{t("لا توجد بطاقات. اطلب بطاقة من الفرع.", "No cards yet. Ask your branch to issue one.")}</Notice>}
      {cards.map((c) => (
        <Card key={c.id}>
          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-2xl bg-gradient-to-br from-slate-800 to-sky-900 p-5 text-white shadow" dir="ltr">
              <div className="flex justify-between text-xs"><span>NEO BANK · VIRTUAL DEBIT</span><Badge v={c.status} lang={lang} /></div>
              <div className="mt-6 font-mono text-lg tracking-widest">{c.maskedPan}</div>
              <div className="mt-4 flex justify-between text-xs"><span>{c.holderName}</span><span>{String(c.expiryMonth).padStart(2, "0")}/{String(c.expiryYear).slice(2)}</span></div>
              <div className="mt-2 text-[10px] text-sky-200">{c.account.accountNumber} · {c.account.currency}</div>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {c.status === "ACTIVE" && <ActionButton tone="danger" endpoint={`/api/portal/cards/${c.id}`} body={{ action: "FREEZE" }} label={t("تجميد مؤقت", "Freeze")} />}
                {c.status === "FROZEN" && <ActionButton endpoint={`/api/portal/cards/${c.id}`} body={{ action: "UNFREEZE" }} label={t("إلغاء التجميد", "Unfreeze")} />}
              </div>
              {c.status === "BLOCKED" && <Notice tone="rose">{t("البطاقة موقوفة. تواصل مع البنك.", "Card blocked. Contact the bank.")} {c.blockReason}</Notice>}
              <div className="text-xs font-semibold">{t("تعيين رقم سري جديد", "Set a new PIN")}</div>
              <ApiForm compact endpoint={`/api/portal/cards/${c.id}`} extra={{ action: "SET_PIN" }} submitLabel={t("حفظ", "Save")} showResult={false} fields={[{ name: "pin", label: "PIN", type: "password", required: true }]} />
              <p className="text-[11px] text-slate-500">{t("يُشفّر الرقم السري فوراً داخل وحدة HSM (محاكاة) ولا يُخزّن نصاً واضحاً أبداً.", "The PIN is encrypted immediately by the (mock) HSM and never stored in clear.")}</p>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold">{t("القنوات والحدود اليومية (ج.م)", "Channels & daily limits (EGP)")}</div>
              <ApiForm key={`${c.id}-${c.onlineEnabled}-${c.atmEnabled}-${c.posEnabled}-${c.contactlessEnabled}-${c.internationalEnabled}-${c.dailyLimit}`} endpoint={`/api/portal/cards/${c.id}`} extra={{ action: "SETTINGS" }} submitLabel={t("حفظ الإعدادات", "Save settings")} showResult={false} resetOnSuccess={false} fields={[
                { name: "atmEnabled", label: t("السحب من الصراف الآلي", "ATM withdrawals"), type: "checkbox", defaultValue: c.atmEnabled },
                { name: "posEnabled", label: t("الشراء من المحلات", "Shop (POS) purchases"), type: "checkbox", defaultValue: c.posEnabled },
                { name: "onlineEnabled", label: t("الشراء عبر الإنترنت", "Online payments"), type: "checkbox", defaultValue: c.onlineEnabled },
                { name: "contactlessEnabled", label: t("الدفع اللاتلامسي", "Contactless"), type: "checkbox", defaultValue: c.contactlessEnabled },
                { name: "internationalEnabled", label: t("الاستخدام خارج مصر", "Use outside Egypt"), type: "checkbox", defaultValue: c.internationalEnabled },
                { name: "dailyLimit", label: t("الحد اليومي الإجمالي", "Overall daily limit"), type: "number", defaultValue: minorToString(c.dailyLimit) },
                { name: "atmDailyLimit", label: t("حد الصراف الآلي", "ATM limit"), type: "number", defaultValue: minorToString(c.atmDailyLimit) },
                { name: "posDailyLimit", label: t("حد نقاط البيع", "POS limit"), type: "number", defaultValue: minorToString(c.posDailyLimit) },
                { name: "ecomDailyLimit", label: t("حد الإنترنت", "Online limit"), type: "number", defaultValue: minorToString(c.ecomDailyLimit) },
                { name: "contactlessNoPinLimit", label: t("حد اللاتلامسي بدون رقم سري", "Contactless no-PIN limit"), type: "number", defaultValue: minorToString(c.contactlessNoPinLimit) },
              ]} />
            </div>
          </div>
          {c.status === "ACTIVE" && (
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
              <div className="mb-2 text-xs font-semibold">{t("تجربة الدفع الإلكتروني مع 3-D Secure (متجر تجريبي MOCK)", "Try an online payment with 3-D Secure (MOCK demo store)")}</div>
              <DemoCheckout cardId={c.id} t={{ amount: t("المبلغ", "Amount"), pay: t("ادفع", "Pay"), otp: t("أدخل رمز 3-D Secure المرسل لموبايلك", "Enter the 3-D Secure code sent to your mobile"), verify: t("تأكيد", "Verify"), approved: t("تمت الموافقة — تم حجز المبلغ", "Approved — amount on hold"), declined: t("مرفوضة", "Declined") }} />
            </div>
          )}
        </Card>
      ))}
      <Card title={t("عمليات البطاقات", "Card transactions")}>
        <Table rows={txns} empty={t("لا توجد عمليات", "No transactions")} cols={[
          { h: t("الوقت", "Time"), c: (a) => <span className="whitespace-nowrap">{dt(a.createdAt)}</span> }, { h: t("القناة", "Channel"), c: (a) => chLabel[a.channel] ?? a.channel },
          { h: t("التاجر / الجهاز", "Merchant / ATM"), c: (a) => <span>{a.merchantName ?? a.terminalId ?? "—"}{a.merchantCountry && a.merchantCountry !== "EG" ? ` (${a.merchantCountry})` : ""}</span> },
          { h: t("المبلغ", "Amount"), c: (a) => <Ltr>{money(a.amount, a.currency)}{a.feeAmount ? ` + ${money(a.feeAmount, "")}` : ""}</Ltr> },
          { h: t("الحالة", "Status"), c: (a) => <span><Badge v={a.status} lang={lang} />{a.declineReason && <span className="ms-1 text-xs text-slate-500">{a.declineReason}</span>}{a.refundedAmount > 0n && <span className="ms-1 text-xs text-sky-700">{t("مسترد", "refunded")} <Ltr>{money(a.refundedAmount, "")}</Ltr></span>}</span> },
          { h: "", c: (a) => a.disputes.length ? <span className="text-xs">{a.disputes.map((d) => `${d.disputeNo} ${d.status}`).join(", ")}</span> : ["COMPLETED", "CAPTURED", "PARTIALLY_REFUNDED"].includes(a.status) && a.amount > 0n ? (
            <ActionButton tone="ghost" endpoint="/api/portal/cards/disputes" body={{ authorizationId: a.id, reason: a.channel === "ATM" ? "CASH_NOT_DISPENSED" : "NOT_RECOGNISED" }} prompt={{ field: "description", label: t("صف المشكلة", "Describe the problem") }} label={a.channel === "ATM" ? t("لم أستلم النقدية", "Cash not received") : t("اعتراض", "Dispute")} />
          ) : null },
        ]} />
      </Card>
    </div>
  );
}
