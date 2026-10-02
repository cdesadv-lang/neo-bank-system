import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import * as R from "@/server/services/reports";
import { PageTitle, Card, Table, Ltr, money, Notice, Json, Badge, dt } from "@/components/ui";
import { REPORTS } from "@/lib/reports-meta";
import type { Currency } from "@prisma/client";

export default async function ReportPage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ currency?: string; from?: string; to?: string; date?: string }> }) {
  const { staff, lang } = await requireStaffPage("report.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const { name } = await params;
  const sp = await searchParams;
  const meta = REPORTS.find((r) => r.id === name);
  if (!meta) notFound();
  const ccy = (sp.currency ?? "EGP") as Currency;
  const from = new Date(sp.from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const to = new Date((sp.to ?? new Date().toISOString().slice(0, 10)) + "T23:59:59Z");
  const glOnly = ["balance-sheet", "income-statement", "trial-balance", "reconcile"].includes(name);
  if (glOnly && !can(staff, "gl.read")) return <Notice tone="rose">{t("هذا التقرير يتطلب صلاحية دفتر الأستاذ", "This report requires GL access")}</Notice>;
  const filters = (
    <form className="flex flex-wrap gap-2 text-sm">
      <select name="currency" defaultValue={ccy} className="rounded border px-2 py-1">{["EGP", "USD", "EUR", "SAR"].map((c) => <option key={c}>{c}</option>)}</select>
      <input type="date" name="from" defaultValue={sp.from} className="rounded border px-2 py-1" /><input type="date" name="to" defaultValue={sp.to} className="rounded border px-2 py-1" />
      <button className="rounded bg-slate-800 px-3 py-1 text-white">{t("عرض", "Show")}</button>
      <a className="rounded border px-3 py-1" href={`/api/staff/reports/${name}?currency=${ccy}${sp.from ? `&from=${sp.from}` : ""}${sp.to ? `&to=${sp.to}` : ""}`}>JSON</a>
    </form>
  );
  let body: React.ReactNode;
  if (name === "balance-sheet") {
    const b = await R.balanceSheet(ccy);
    const sec = (title: string, rows: typeof b.assets) => <div><h3 className="mb-1 font-semibold">{title}</h3><Table rows={rows.filter((r) => r.balance !== 0n)} cols={[{ h: "GL", c: (r) => <Ltr>{r.code}</Ltr> }, { h: t("الحساب", "Account"), c: (r) => tr(lang, r.nameAr, r.nameEn) }, { h: t("الرصيد", "Balance"), c: (r) => <Ltr>{money(r.balance, ccy)}</Ltr> }]} /></div>;
    body = <div className="grid gap-4 md:grid-cols-3">{sec(t("الأصول", "Assets"), b.assets)}{sec(t("الالتزامات", "Liabilities"), b.liabilities)}{sec(t("حقوق الملكية", "Equity"), b.equity)}
      <p className={`md:col-span-3 text-sm font-semibold ${b.totals.balanced ? "text-emerald-700" : "text-rose-700"}`} dir="ltr">Assets {money(b.totals.assets, ccy)} = Liabilities {money(b.totals.liabilities, ccy)} + Equity {money(b.totals.equity, ccy)} + Current earnings {money(b.totals.currentEarnings, ccy)} {b.totals.balanced ? "✓" : "✗"}</p></div>;
  } else if (name === "income-statement") {
    const s = await R.incomeStatement(ccy, from, to);
    body = <><Table rows={s.items} cols={[{ h: "GL", c: (i: { code: string }) => <Ltr>{i.code}</Ltr> }, { h: t("الحساب", "Account"), c: (i: { nameAr: string; nameEn: string }) => tr(lang, i.nameAr, i.nameEn) }, { h: t("المبلغ", "Amount"), c: (i: { amount: bigint }) => <Ltr>{money(i.amount, ccy)}</Ltr> }]} />
      <p className="mt-3 text-sm font-semibold" dir="ltr">Income {money(s.income, ccy)} − Expense {money(s.expense, ccy)} = Net {money(s.netIncome, ccy)}</p></>;
  } else if (name === "trial-balance") {
    const tb = await R.trialBalance();
    body = <Table rows={tb.rows.filter((r) => r.currency === ccy)} cols={[{ h: "GL", c: (r) => <Ltr>{r.code}</Ltr> }, { h: t("الحساب", "Account"), c: (r) => tr(lang, r.nameAr, r.nameEn) }, { h: t("مدين", "Debit"), c: (r) => <Ltr>{money(r.debit, "")}</Ltr> }, { h: t("دائن", "Credit"), c: (r) => <Ltr>{money(r.credit, "")}</Ltr> }, { h: t("الرصيد", "Balance"), c: (r) => <Ltr>{money(r.balance, "")}</Ltr> }]} />;
  } else if (name === "reconcile") {
    const r = await R.reconcile();
    body = r.ok ? <Notice tone="sky">✓ {t("كل الدفاتر المساعدة مطابقة لدفتر الأستاذ وميزان المراجعة متوازن", "All sub-ledgers agree with the GL and the trial balance is balanced")}</Notice> : <Notice tone="rose"><ul>{r.breaks.map((b, i) => <li key={i} dir="ltr">{b}</li>)}</ul></Notice>;
  } else if (name === "loan-portfolio") {
    const p = await R.loanPortfolio(staff);
    body = <><p className="mb-2 text-sm" dir="ltr">Outstanding {money(p.outstanding)} · NPL {money(p.npl)} · NPL ratio {(p.nplRatioBps / 100).toFixed(2)}%</p>
      <Table rows={Object.entries(p.byClass)} cols={[{ h: t("التصنيف", "Class"), c: ([k]) => k }, { h: t("عدد", "Count"), c: ([, v]) => v.count }, { h: t("القائم", "Outstanding"), c: ([, v]) => <Ltr>{money(v.outstanding)}</Ltr> }]} /></>;
  } else if (name === "teller-cash") {
    const r = await R.tellerCash(staff);
    body = <Table rows={r.tills} cols={[{ h: t("الخزينة", "Till"), c: (x) => <Ltr>{x.code}</Ltr> }, { h: t("النوع", "Kind"), c: (x) => x.kind }, { h: t("الفرع", "Branch"), c: (x) => tr(lang, x.branch.nameAr, x.branch.nameEn) }, { h: t("الرصيد", "Balance"), c: (x) => <Ltr>{money(x.balance, x.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> }, { h: t("آخر موازنة", "Last balancing"), c: (x) => x.balancings[0] ? <Ltr>{dt(x.balancings[0].createdAt)} Δ {money(x.balancings[0].variance, "")}</Ltr> : "—" }]} />;
  } else if (name === "atm") {
    const r = await R.atmReport(staff);
    body = <><Table rows={r.atms} cols={[{ h: "ATM", c: (a) => <Ltr>{a.terminalId}</Ltr> }, { h: t("الموقع", "Location"), c: (a) => tr(lang, a.locationAr, a.location) }, { h: t("الحالة", "Status"), c: (a) => <Badge v={a.status} lang={lang} /> }, { h: t("دفتري", "Ledger"), c: (a) => <Ltr>{money(a.ledgerCash)}</Ltr> }, { h: t("الكاسيت", "Cassettes"), c: (a) => <Ltr>{money(a.cassetteCash)}</Ltr> }, { h: t("الفرق", "Diff"), c: (a) => <Ltr>{money(a.cassetteCash - a.ledgerCash)}</Ltr> }]} />
      <h3 className="mb-1 mt-4 text-sm font-semibold">{t("عمليات اليوم", "Today")}</h3><Json v={r.today} /></>;
  } else if (name === "cards") {
    const r = await R.cardActivity(staff);
    body = <><p className="mb-2 text-sm" dir="ltr">Open holds: {r.openHolds._count} · {money(r.openHolds._sum.amount ?? 0n)}</p>
      <Table rows={r.byChannel} cols={[{ h: t("القناة", "Channel"), c: (x) => x.channel }, { h: t("الحالة", "Status"), c: (x) => <Badge v={x.status} lang={lang} /> }, { h: t("عدد", "Count"), c: (x) => x._count }, { h: t("المبلغ", "Amount"), c: (x) => <Ltr>{money(x._sum.amount ?? 0n)}</Ltr> }]} /></>;
  } else if (name === "deposits") body = <Json v={(await R.depositsReport(staff)).sums} />;
  else if (name === "aml") body = <Json v={await R.amlReport(staff)} />;
  else if (name === "daily") body = <Json v={await R.dailyTransactions(staff, sp.date)} />;
  return (
    <div className="space-y-5">
      <PageTitle title={tr(lang, meta.ar, meta.en)} actions={filters} />
      <Card>{body}</Card>
    </div>
  );
}
