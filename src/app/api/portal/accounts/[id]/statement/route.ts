import { portalApi } from "@/server/http";
import { myStatement } from "@/server/services/portal";
import { statementCsv, statementPdf } from "@/server/statement-export";
export const GET = portalApi(async (req, { customer, params }) => {
  const u = new URL(req.url);
  const from = u.searchParams.get("from") ? new Date(u.searchParams.get("from")!) : undefined;
  const to = u.searchParams.get("to") ? new Date(u.searchParams.get("to") + "T23:59:59Z") : undefined;
  const s = await myStatement(customer.customerId, params.id, from, to);
  const fmt = u.searchParams.get("format");
  if (fmt === "csv") return new Response(statementCsv(s), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${s.account.accountNumber}.csv"`, "cache-control": "no-store" } });
  if (fmt === "pdf") return new Response(new Uint8Array(statementPdf(s)), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="statement-${s.account.accountNumber}.pdf"`, "cache-control": "no-store" } });
  return s;
});
