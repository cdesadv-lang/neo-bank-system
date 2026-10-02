import { staffApi } from "@/server/http";
import { listAccounts, openAccount } from "@/server/services/accounts";
export const GET = staffApi("account.read", async (req, { staff }) => {
  const u = new URL(req.url);
  return listAccounts(staff, { q: u.searchParams.get("q") ?? undefined, status: u.searchParams.get("status") ?? undefined, type: u.searchParams.get("type") ?? undefined });
});
export const POST = staffApi("account.open", async (req, { staff, actor }) => openAccount(staff, actor, await req.json()));
