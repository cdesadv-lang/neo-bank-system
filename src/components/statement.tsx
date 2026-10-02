import { tr, type Lang } from "@/lib/i18n";
import { Table, Ltr, money, dt, Card } from "./ui";
import type { accountStatement } from "@/server/services/accounts";

type S = Awaited<ReturnType<typeof accountStatement>>;

export function StatementView({ s, lang, exportBase, from, to }: { s: S; lang: Lang; exportBase: string; from?: string; to?: string }) {
  const t = (a: string, e: string) => tr(lang, a, e);
  const q = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const ccy = s.account.currency;
  return (
    <Card title={t("كشف الحساب", "Statement")} actions={
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <form className="flex flex-wrap items-center gap-1">
          <input type="date" name="from" defaultValue={from} className="rounded border border-slate-300 px-1 py-0.5" />
          <input type="date" name="to" defaultValue={to} className="rounded border border-slate-300 px-1 py-0.5" />
          <button className="rounded bg-slate-800 px-2 py-0.5 text-white">{t("عرض", "Show")}</button>
        </form>
        <a className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50" href={`${exportBase}?format=csv&${q}`}>CSV</a>
        <a className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50" href={`${exportBase}?format=pdf&${q}`}>PDF</a>
      </div>
    }>
      <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>{t("الرصيد الافتتاحي", "Opening balance")}: <Ltr>{money(s.openingBalance, ccy)}</Ltr></span><span>{t("الرصيد الختامي", "Closing balance")}: <Ltr>{money(s.closingBalance, ccy)}</Ltr></span></div>
      {/* phones: one card per movement */}
      <ul className="divide-y divide-slate-100 sm:hidden">
        {s.rows.length === 0 && <li className="py-6 text-center text-sm text-slate-400">{t("لا توجد حركات", "No transactions")}</li>}
        {[...s.rows].reverse().map((r, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-800">{r.description}{r.status === "REVERSED" && <span className="ms-1 text-xs text-rose-600">({t("معكوس", "reversed")})</span>}</div>
              <div className="text-xs text-slate-500">{dt(r.date)} · <Ltr>{r.entryNo}</Ltr></div>
            </div>
            <div className="shrink-0 text-end">
              <div className={`font-semibold ${r.credit ? "text-emerald-700" : "text-slate-800"}`}><Ltr>{r.credit ? `+${money(r.credit, "")}` : `−${money(r.debit, "")}`}</Ltr></div>
              <div className="text-xs text-slate-500"><Ltr>{money(r.balance, ccy)}</Ltr></div>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
      <Table rows={[...s.rows].reverse()} empty={t("لا توجد حركات", "No transactions")} cols={[
        { h: t("التاريخ", "Date"), c: (r) => <span className="whitespace-nowrap">{dt(r.date)}</span> },
        { h: t("القيد", "Entry"), c: (r) => <Ltr>{r.entryNo}</Ltr> },
        { h: t("البيان", "Description"), c: (r) => <span>{r.description}{r.status === "REVERSED" && <span className="ms-1 text-xs text-rose-600">({t("معكوس", "reversed")})</span>}</span> },
        { h: t("مدين", "Debit"), c: (r) => r.debit ? <Ltr>{money(r.debit, "")}</Ltr> : "" },
        { h: t("دائن", "Credit"), c: (r) => r.credit ? <Ltr>{money(r.credit, "")}</Ltr> : "" },
        { h: t("الرصيد", "Balance"), c: (r) => <Ltr>{money(r.balance, "")}</Ltr> },
      ]} />
      </div>
    </Card>
  );
}
