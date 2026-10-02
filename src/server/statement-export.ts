import { minorToString } from "@/lib/money";
import { formatIban } from "@/lib/iban";
import { buildPdf, type PdfLine } from "@/lib/pdf";
import type { accountStatement } from "./services/accounts";

type Stmt = Awaited<ReturnType<typeof accountStatement>>;

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function statementCsv(s: Stmt): string {
  const head = [
    `Neo Bank (Demo) - Account statement / كشف حساب`,
    `Account,${s.account.accountNumber}`,
    `Customer,${csvCell(s.account.customer.nameEn)} / ${csvCell(s.account.customer.nameAr)}`,
    `Currency,${s.account.currency}`,
    `Period,${s.from.toISOString().slice(0, 10)},${s.to.toISOString().slice(0, 10)}`,
    `Opening balance,${minorToString(s.openingBalance)}`,
    "",
    "date,value_date,entry_no,type,description,debit,credit,balance,status",
  ];
  const rows = s.rows.map((r) => [r.date.toISOString(), r.valueDate.toISOString().slice(0, 10), r.entryNo, r.type, csvCell(r.description), minorToString(r.debit), minorToString(r.credit), minorToString(r.balance), r.status].join(","));
  return "\uFEFF" + [...head, ...rows, "", `Closing balance,${minorToString(s.closingBalance)}`].join("\n");
}

export function statementPdf(s: Stmt): Buffer {
  const header: PdfLine[] = [
    { text: "NEO BANK (DEMO) - ACCOUNT STATEMENT", size: 14, bold: true },
    { text: `Account: ${formatIban(s.account.accountNumber)}   Currency: ${s.account.currency}   Type: ${s.account.type}` },
    { text: `Customer: ${s.account.customer.nameEn}  (CIF ${s.account.customer.cif})   Branch: ${s.account.branch.nameEn}` },
    { text: `Period: ${s.from.toISOString().slice(0, 10)} to ${s.to.toISOString().slice(0, 10)}   Opening balance: ${minorToString(s.openingBalance)}` },
    { text: " " },
    { text: pad("Date", 11) + pad("Entry", 11) + pad("Description", 44) + padL("Debit", 13) + padL("Credit", 13) + padL("Balance", 14), bold: true },
  ];
  const body: PdfLine[] = s.rows.map((r) => ({
    text: pad(r.date.toISOString().slice(0, 10), 11) + pad(r.entryNo, 11) + pad(r.description.replace(/[^\x20-\x7E]/g, ""), 44) + padL(r.debit ? minorToString(r.debit) : "", 13) + padL(r.credit ? minorToString(r.credit) : "", 13) + padL(minorToString(r.balance), 14),
    size: 7,
  }));
  const pages: PdfLine[][] = [];
  const per = 75;
  for (let i = 0; i < Math.max(1, body.length); i += per) pages.push([...header, ...body.slice(i, i + per)]);
  pages[pages.length - 1].push({ text: " " }, { text: `Closing balance: ${minorToString(s.closingBalance)} ${s.account.currency}`, bold: true }, { text: "Generated electronically. Demo system - not a real bank.", size: 7 });
  return buildPdf(pages);
}

function pad(s: string, n: number) {
  return (s.length > n - 1 ? s.slice(0, n - 2) + "~" : s).padEnd(n, " ");
}
function padL(s: string, n: number) {
  return s.padStart(n, " ");
}
