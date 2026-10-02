import { staffApi } from "@/server/http";
import { accountStatement, getAccount } from "@/server/services/accounts";
import { statementCsv, statementPdf } from "@/server/statement-export";
import { audit } from "@/server/audit";
export const GET = staffApi("account.read", async (req, { staff, actor, params }) => {
  await getAccount(staff, params.id); // branch scope check
  const u = new URL(req.url);
  const from = u.searchParams.get("from") ? new Date(u.searchParams.get("from")!) : undefined;
  const to = u.searchParams.get("to") ? new Date(u.searchParams.get("to") + "T23:59:59Z") : undefined;
  const s = await accountStatement(params.id, from, to);
  const fmt = u.searchParams.get("format");
  await audit(actor, "STATEMENT_VIEWED", { type: "Account", id: params.id }, undefined, { format: fmt ?? "json" });
  if (fmt === "csv") return new Response(statementCsv(s), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="statement-${s.account.accountNumber}.csv"` } });
  if (fmt === "pdf") return new Response(new Uint8Array(statementPdf(s)), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="statement-${s.account.accountNumber}.pdf"` } });
  return s;
});
