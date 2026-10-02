import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can, branchWhere } from "@/server/rbac";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, Ltr, money, dt, Grid, Stat } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client";
import { PosSimulatorForm } from "@/components/simulators";
import { RESPONSE_CODES } from "@/server/services/card-auth";

export default async function CardAuths({ searchParams }: { searchParams: Promise<{ status?: string; channel?: string; cardId?: string }> }) {
  const { staff, lang } = await requireStaffPage("card.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const scope = { card: { account: branchWhere(staff) } };
  const rows = await prisma.cardAuthorization.findMany({
    where: { ...scope, ...(sp.status ? { status: sp.status } : {}), ...(sp.channel ? { channel: sp.channel } : {}), ...(sp.cardId ? { cardId: sp.cardId } : {}) },
    include: { card: { select: { maskedPan: true, customer: { select: { nameAr: true, nameEn: true } } } } }, orderBy: { createdAt: "desc" }, take: 150,
  });
  const holds = await prisma.cardAuthorization.aggregate({ where: { ...scope, status: "AUTHORIZED" }, _sum: { amount: true }, _count: true });
  const byChannel = await prisma.cardAuthorization.groupBy({ by: ["channel"], where: { ...scope, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) }, status: { not: "DECLINED" } }, _count: true, _sum: { amount: true } });
  const cards = can(staff, "card.manage") ? await prisma.card.findMany({ where: { account: branchWhere(staff), status: "ACTIVE" }, include: { customer: true }, take: 100, orderBy: { createdAt: "asc" } }) : [];
  return (
    <div className="space-y-5">
      <PageTitle title={t("عمليات البطاقات (كل القنوات)", "Card transactions (all channels)")} subtitle={t("تفويض ← حجز ← تسوية / فك الحجز ← عكس ← استرداد. كل حدث يرحّل لحظياً في دفتر الأستاذ.", "Authorize → hold → capture / release → reverse → refund. Every event posts to the ledger in real time.")} actions={<AutoRefresh label={t("تحديث تلقائي", "Live")} />} />
      <Grid>
        <Stat label={t("مبالغ محجوزة قائمة", "Open holds")} value={money(holds._sum.amount ?? 0n)} hint={`${holds._count} ${t("عملية", "auths")}`} tone="amber" />
        {byChannel.map((c) => <Stat key={c.channel} label={`${c.channel} · 30d`} value={money(c._sum.amount ?? 0n)} hint={`${c._count}`} />)}
      </Grid>
      {can(staff, "card.manage") && cards.length > 0 && (
        <Card title={t("محاكي نقاط البيع / التجارة الإلكترونية / اللاتلامسي", "POS / e-commerce / contactless simulator")}>
          <PosSimulatorForm cards={cards.map((c) => ({ value: c.id, label: `${c.maskedPan} · ${tr(lang, c.customer.nameAr, c.customer.nameEn)}` }))} t={{ card: t("البطاقة", "Card"), mode: t("القناة", "Channel"), amount: t("المبلغ", "Amount"), merchant: t("التاجر", "Merchant"), country: t("الدولة", "Country"), send: t("إرسال تفويض", "Send authorization"), threeDs: t("مطلوب رمز 3-D Secure المرسل لموبايل العميل", "3-D Secure code sent to the cardholder's mobile is required"), verify: t("تحقق", "Verify") }} />
        </Card>
      )}
      <Card>
        <form className="mb-3 flex flex-wrap gap-2 text-sm">
          <select name="channel" defaultValue={sp.channel ?? ""} className="rounded border border-slate-300 px-2 py-1.5"><option value="">{t("كل القنوات", "All channels")}</option>{["ATM", "POS", "ECOM", "CONTACTLESS"].map((c) => <option key={c}>{c}</option>)}</select>
          <select name="status" defaultValue={sp.status ?? ""} className="rounded border border-slate-300 px-2 py-1.5"><option value="">{t("كل الحالات", "All statuses")}</option>{["AUTHORIZED", "CAPTURED", "COMPLETED", "RELEASED", "REVERSED", "REFUNDED", "PARTIALLY_REFUNDED", "DECLINED", "PENDING_3DS"].map((c) => <option key={c}>{c}</option>)}</select>
          {sp.cardId && <input type="hidden" name="cardId" value={sp.cardId} />}
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("تصفية", "Filter")}</button>
        </form>
        <Table rows={rows} cols={[
          { h: t("الوقت", "Time"), c: (a) => <span className="whitespace-nowrap">{dt(a.createdAt)}</span> }, { h: "RRN", c: (a) => <Ltr>{a.rrn}</Ltr> },
          { h: t("البطاقة", "Card"), c: (a) => <span><Ltr>{a.card.maskedPan.slice(-4)}</Ltr> {tr(lang, a.card.customer.nameAr, a.card.customer.nameEn)}</span> },
          { h: t("القناة", "Channel"), c: (a) => <span>{a.channel}<span className="text-xs text-slate-500"> {a.acquirer === "NETWORK" ? t("(بنك آخر)", "(network)") : ""}</span></span> },
          { h: t("التاجر / الجهاز", "Merchant / terminal"), c: (a) => <span>{a.merchantName ?? a.terminalId ?? "—"} <span className="text-xs text-slate-500" dir="ltr">{a.mcc ? `MCC ${a.mcc}` : ""} {a.merchantCountry}</span></span> },
          { h: t("المبلغ", "Amount"), c: (a) => <Ltr>{money(a.amount, a.currency)}</Ltr> },
          { h: t("مسوّى / مسترد", "Captured / refunded"), c: (a) => <Ltr>{money(a.capturedAmount, "")} / {money(a.refundedAmount, "")}</Ltr> },
          { h: t("الحالة", "Status"), c: (a) => <span><Badge v={a.status} lang={lang} /> <span className="text-xs text-slate-500" title={RESPONSE_CODES[a.responseCode]}>{a.responseCode}{a.declineReason ? ` ${a.declineReason}` : ""}</span></span> },
          { h: "", c: (a) => can(staff, "card.manage") ? (
            <div className="flex flex-wrap gap-1">
              {a.status === "AUTHORIZED" && <><ActionButton endpoint={`/api/staff/card-auths/${a.id}`} body={{ action: "CAPTURE" }} label={t("تسوية", "Capture")} /><ActionButton tone="ghost" endpoint={`/api/staff/card-auths/${a.id}`} body={{ action: "RELEASE" }} label={t("فك الحجز", "Release")} /></>}
              {a.status === "COMPLETED" && a.amount > 0n && <ActionButton tone="danger" endpoint={`/api/staff/card-auths/${a.id}`} body={{ action: "REVERSE" }} confirm={t("عكس العملية؟", "Reverse this transaction?")} label={t("عكس", "Reverse")} />}
              {(a.status === "CAPTURED" || a.status === "PARTIALLY_REFUNDED") && <ActionButton tone="ghost" endpoint={`/api/staff/card-auths/${a.id}`} body={{ action: "REFUND", idempotencyKey: `ui-${a.id}-${a.refundedAmount}` }} prompt={{ field: "amount", label: t("مبلغ الاسترداد", "Refund amount") }} label={t("استرداد", "Refund")} />}
            </div>) : null },
        ]} />
      </Card>
    </div>
  );
}
