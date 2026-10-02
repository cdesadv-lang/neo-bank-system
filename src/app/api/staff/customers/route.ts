import { staffApi } from "@/server/http";
import { listCustomers, createCustomer } from "@/server/services/customers";
export const GET = staffApi("customer.read", async (req, { staff }) => {
  const u = new URL(req.url);
  return listCustomers(staff, { q: u.searchParams.get("q") ?? undefined, kycStatus: u.searchParams.get("kycStatus") ?? undefined, take: Math.min(Number(u.searchParams.get("take") ?? 50), 200), skip: Number(u.searchParams.get("skip") ?? 0) });
});
export const POST = staffApi("customer.create", async (req, { staff, actor }) => createCustomer(staff, actor, await req.json()));
