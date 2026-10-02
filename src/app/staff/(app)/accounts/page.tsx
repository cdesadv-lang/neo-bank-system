import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { listAccounts } from "@/server/services/accounts";
import { PageTitle, Card, Table, Badge, A, Ltr, money } from "@/components/ui";
import { formatIban } from "@/lib/iban";

export default async function Accounts({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; type?: string }> }) {
  const { staff, lang } = await requireStaffPage("account.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const sp = await searchParams;
  const rows = await listAccounts(staff, { q: sp.q, status: sp.status || undefined, type: sp.type || undefined, take: 200 });
  return (
    <div className="space-y-5">
      <PageTitle title={t("الحسابات", "Accounts")} />
      <Card>
        <form className="flex flex-wrap gap-2 text-sm">
          <input name="q" defaultValue={sp.q} placeholder={t("IBAN / اسم العميل / CIF", "IBAN / customer / CIF")} className="w-72 rounded border border-slate-300 px-2 py-1.5" />
          <select name="type" defaultValue={sp.type ?? ""} className="rounded border border-slate-300 px-2 py-1.5"><option value="">{t("كل الأنواع", "All types")}</option>{["CURRENT", "SAVINGS", "TERM_DEPOSIT"].map((x) => <option key={x}>{x}</option>)}</select>
          <select name="status" defaultValue={sp.status ?? ""} className="rounded border border-slate-300 px-2 py-1.5"><option value="">{t("كل الحالات", "All statuses")}</option>{["ACTIVE", "PENDING", "FROZEN", "DORMANT", "CLOSED"].map((x) => <option key={x}>{x}</option>)}</select>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white">{t("بحث", "Search")}</button>
        </form>
      </Card>
      <Card>
        <Table rows={rows} cols={[
          { h: "IBAN", c: (a) => <A href={`/staff/accounts/${a.id}`}><Ltr>{formatIban(a.accountNumber)}</Ltr></A> },
          { h: t("العميل", "Customer"), c: (a) => <A href={`/staff/customers/${a.customerId}`}>{tr(lang, a.customer.nameAr, a.customer.nameEn)}</A> },
          { h: t("النوع", "Type"), c: (a) => a.type }, { h: t("الفرع", "Branch"), c: (a) => tr(lang, a.branch.nameAr, a.branch.nameEn) },
          { h: t("الرصيد", "Balance"), c: (a) => <Ltr>{money(a.balance, a.currency)}</Ltr> },
          { h: t("العائد", "Rate"), c: (a) => a.interestRateBps ? `${a.interestRateBps / 100}%` : "—" },
          { h: t("الحالة", "Status"), c: (a) => <Badge v={a.status} lang={lang} /> },
        ]} />
      </Card>
    </div>
  );
}
