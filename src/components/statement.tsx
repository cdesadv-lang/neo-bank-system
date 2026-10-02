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
        <form className="flex items-center gap-1">
          <input type="date" name="from" defaultValue={from} className="rounded border border-slate-300 px-1 py-0.5" />
          <input type="date" name="to" defaultValue={to} className="rounded border border-slate-300 px-1 py-0.5" />
          <button className="rounded bg-slate-800 px-2 py-0.5 text-white">{t("عرض", "Show")}</button>
        </form>
        <a className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50" href={`${exportBase}?format=csv&${q}`}>CSV</a>
        <a className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50" href={`${exportBase}?format=pdf&${q}`}>PDF</a>
      </div>
    }>
      <div className="mb-2 flex gap-6 text-sm"><span>{t("الرصيد الافتتاحي", "Opening balance")}: <Ltr>{money(s.openingBalance, ccy)}</Ltr></span><span>{t("الرصيد الختامي", "Closing balance")}: <Ltr>{money(s.closingBalance, ccy)}</Ltr></span></div>
      <Table rows={[...s.rows].reverse()} empty={t("لا توجد حركات", "No transactions")} cols={[
        { h: t("التاريخ", "Date"), c: (r) => <span className="whitespace-nowrap">{dt(r.date)}</span> },
        { h: t("القيد", "Entry"), c: (r) => <Ltr>{r.entryNo}</Ltr> },
        { h: t("البيان", "Description"), c: (r) => <span>{r.description}{r.status === "REVERSED" && <span className="ms-1 text-xs text-rose-600">({t("معكوس", "reversed")})</span>}</span> },
        { h: t("مدين", "Debit"), c: (r) => r.debit ? <Ltr>{money(r.debit, "")}</Ltr> : "" },
        { h: t("دائن", "Credit"), c: (r) => r.credit ? <Ltr>{money(r.credit, "")}</Ltr> : "" },
        { h: t("الرصيد", "Balance"), c: (r) => <Ltr>{money(r.balance, "")}</Ltr> },
      ]} />
    </Card>
  );
}
