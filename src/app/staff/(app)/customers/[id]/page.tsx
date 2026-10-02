import { requireStaffPage } from "@/server/page-auth";
import { tr } from "@/lib/i18n";
import { can } from "@/server/rbac";
import { getCustomer } from "@/server/services/customers";
import { prisma } from "@/lib/db";
import { PageTitle, Card, Table, Badge, A, Ltr, money, dt, Grid } from "@/components/ui";
import { ApiForm, ActionButton } from "@/components/client";
import { formatIban } from "@/lib/iban";
import { TD_RATES } from "@/server/services/deposits";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { staff, lang } = await requireStaffPage("customer.read");
  const t = (a: string, e: string) => tr(lang, a, e);
  const { id } = await params;
  const c = await getCustomer(staff, id);
  const products = await prisma.loanProduct.findMany({ where: { active: true } });
  const accOpts = c.accounts.filter((a) => a.type !== "TERM_DEPOSIT" && a.status === "ACTIVE").map((a) => ({ value: a.id, label: `${a.accountNumber} · ${a.currency} · ${money(a.balance, a.currency)}` }));
  return (
    <div className="space-y-5">
      <PageTitle title={tr(lang, c.nameAr, c.nameEn)} subtitle={`CIF ${c.cif} · ${tr(lang, c.branch.nameAr, c.branch.nameEn)}`} actions={<><Badge v={c.kycStatus} lang={lang} /><Badge v={c.riskRating} lang={lang} /></>} />
      <Grid cols={3}>
        <Card title={t("البيانات", "Profile")}>
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-slate-500">{t("النوع", "Type")}</dt><dd>{c.type}</dd>
            <dt className="text-slate-500">{t("الرقم القومي", "National ID")}</dt><dd><Ltr>{c.nationalId ?? c.commercialRegNo ?? "—"}</Ltr></dd>
            <dt className="text-slate-500">{t("الموبايل", "Mobile")}</dt><dd><Ltr>{c.phone}</Ltr></dd>
            <dt className="text-slate-500">{t("البريد", "Email")}</dt><dd><Ltr>{c.email ?? "—"}</Ltr></dd>
            <dt className="text-slate-500">{t("المهنة", "Occupation")}</dt><dd>{c.occupation ?? "—"}</dd>
            <dt className="text-slate-500">{t("العنوان", "Address")}</dt><dd>{c.address ?? "—"}</dd>
            <dt className="text-slate-500">{t("الخدمات الرقمية", "Digital banking")}</dt><dd>{c.user ? <Ltr>{c.user.username}</Ltr> : "—"}</dd>
          </dl>
        </Card>
        <Card title={t("مستندات KYC", "KYC documents")}>
          <Table rows={c.documents} cols={[{ h: t("النوع", "Type"), c: (d) => d.docType }, { h: t("الرقم", "No."), c: (d) => <Ltr>{d.docNumber ?? "—"}</Ltr> }, { h: t("الانتهاء", "Expiry"), c: (d) => dt(d.expiryDate, false) }]} />
          {can(staff, "customer.update") && <div className="mt-3"><ApiForm compact endpoint={`/api/staff/customers/${c.id}/documents`} submitLabel={t("إضافة", "Add")} showResult={false} fields={[
            { name: "docType", label: t("النوع", "Type"), type: "select", options: ["NATIONAL_ID", "PASSPORT", "COMMERCIAL_REGISTER", "TAX_CARD", "UTILITY_BILL", "BOARD_RESOLUTION", "OTHER"].map((v) => ({ value: v, label: v })) },
            { name: "docNumber", label: t("الرقم", "Number"), ltr: true }, { name: "expiryDate", label: t("الانتهاء", "Expiry"), type: "date" }]} /></div>}
        </Card>
        <Card title={t("الإجراءات", "Actions")}>
          <div className="space-y-3">
            {can(staff, "customer.update") && <div className="flex flex-wrap gap-1">{(["LOW", "MEDIUM", "HIGH"] as const).map((r) => <ActionButton key={r} tone="ghost" endpoint={`/api/staff/customers/${c.id}/risk`} body={{ riskRating: r }} label={`${t("مخاطر", "Risk")} ${r}`} />)}</div>}
            {can(staff, "customer.update") && !c.user && <ApiForm endpoint={`/api/staff/customers/${c.id}/digital-access`} submitLabel={t("تفعيل الخدمات الرقمية", "Enable digital banking")} showResult={false} fields={[{ name: "username", label: t("اسم المستخدم", "Username"), ltr: true, required: true }, { name: "password", label: t("كلمة مرور مؤقتة", "Temporary password"), type: "password", required: true }]} />}
          </div>
        </Card>
      </Grid>
      <Card title={t("الحسابات", "Accounts")}>
        <Table rows={c.accounts} cols={[
          { h: "IBAN", c: (a) => <A href={`/staff/accounts/${a.id}`}><Ltr>{formatIban(a.accountNumber)}</Ltr></A> },
          { h: t("النوع", "Type"), c: (a) => a.type }, { h: t("العملة", "CCY"), c: (a) => a.currency },
          { h: t("الرصيد", "Balance"), c: (a) => <Ltr>{money(a.balance, a.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (a) => <Badge v={a.status} lang={lang} /> },
        ]} />
        {can(staff, "account.open") && <div className="mt-3"><ApiForm compact endpoint="/api/staff/accounts" extra={{ customerId: c.id }} submitLabel={t("فتح حساب", "Open account")} showResult={false} fields={[
          { name: "type", label: t("النوع", "Type"), type: "select", options: [{ value: "CURRENT", label: t("جاري", "Current") }, { value: "SAVINGS", label: t("توفير", "Savings") }] },
          { name: "currency", label: t("العملة", "Currency"), type: "select", options: ["EGP", "USD", "EUR", "SAR"].map((x) => ({ value: x, label: x })) },
          { name: "nickname", label: t("اسم مختصر", "Nickname") }]} /></div>}
      </Card>
      <Grid cols={2}>
        <Card title={t("البطاقات", "Cards")}>
          <Table rows={c.cards} cols={[{ h: t("البطاقة", "Card"), c: (k) => <Ltr>{k.maskedPan}</Ltr> }, { h: t("الحالة", "Status"), c: (k) => <Badge v={k.status} lang={lang} /> }, { h: t("الحد اليومي", "Daily limit"), c: (k) => <Ltr>{money(k.dailyLimit)}</Ltr> }]} />
          {can(staff, "card.manage") && accOpts.length > 0 && <div className="mt-3"><ApiForm compact endpoint="/api/staff/cards" submitLabel={t("إصدار بطاقة افتراضية", "Issue virtual card")} showResult={false} fields={[{ name: "accountId", label: t("الحساب", "Account"), type: "select", options: accOpts }]} /></div>}
        </Card>
        <Card title={t("القروض", "Loans")}>
          <Table rows={c.loans} cols={[{ h: "#", c: (l) => <A href={`/staff/loans/${l.id}`}><Ltr>{l.loanNumber}</Ltr></A> }, { h: t("المبلغ", "Principal"), c: (l) => <Ltr>{money(l.principal, l.currency)}</Ltr> }, { h: t("الحالة", "Status"), c: (l) => <Badge v={l.status} lang={lang} /> }]} />
          {can(staff, "loan.apply") && accOpts.length > 0 && <div className="mt-3"><ApiForm endpoint="/api/staff/loans" extra={{ customerId: c.id }} submitLabel={t("طلب قرض", "Apply for loan")} showResult={false} fields={[
            { name: "productId", label: t("المنتج", "Product"), type: "select", options: products.map((p) => ({ value: p.id, label: `${tr(lang, p.nameAr, p.nameEn)} (${p.annualRateBps / 100}%)` })) },
            { name: "accountId", label: t("حساب الصرف والسداد", "Disbursement/repayment account"), type: "select", options: accOpts },
            { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true }, { name: "termMonths", label: t("المدة (شهور)", "Term (months)"), type: "number", required: true, defaultValue: "24" },
            { name: "purpose", label: t("الغرض", "Purpose"), wide: true }]} /></div>}
        </Card>
      </Grid>
      {can(staff, "deposit.open") && accOpts.length > 0 && (
        <Card title={t("فتح وديعة لأجل", "Open term deposit")}>
          <ApiForm idempotent endpoint={`/api/staff/customers/${c.id}/term-deposits`} submitLabel={t("فتح", "Open")} fields={[
            { name: "sourceAccountId", label: t("من حساب", "From account"), type: "select", options: accOpts },
            { name: "amount", label: t("المبلغ", "Amount"), type: "number", required: true },
            { name: "termMonths", label: t("المدة", "Term"), type: "select", options: Object.entries(TD_RATES.EGP).map(([m, r]) => ({ value: m, label: `${m} ${t("شهر", "months")} · ${r / 100}% (EGP)` })) },
            { name: "interestPayout", label: t("العائد", "Interest"), type: "select", options: [{ value: "CAPITALIZE", label: t("يضاف للوديعة", "Capitalize") }, { value: "PAYOUT", label: t("يصرف للحساب", "Pay out") }] }]} />
        </Card>
      )}
      <Card title={t("تنبيهات AML", "AML alerts")}>
        <Table rows={c.amlAlerts} cols={[{ h: t("القاعدة", "Rule"), c: (a) => <span>{a.alertNo} · {a.details}</span> }, { h: t("الحالة", "Status"), c: (a) => <Badge v={a.status} lang={lang} /> }, { h: t("التاريخ", "Date"), c: (a) => dt(a.createdAt) }]} />
      </Card>
    </div>
  );
}
