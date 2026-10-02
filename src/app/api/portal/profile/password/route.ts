import { portalApi, json } from "@/server/http";
import { changeCustomerPassword } from "@/server/services/portal";
import { PORTAL_COOKIE, sessionCookie } from "@/server/auth/session";
export const POST = portalApi(async (req, { customer, actor }) => {
  const r = await changeCustomerPassword(customer, actor, await req.json());
  return json(r, 200, { "set-cookie": sessionCookie(PORTAL_COOKIE, "", 0) });
});
