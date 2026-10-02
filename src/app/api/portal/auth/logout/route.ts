import { publicApi, json } from "@/server/http";
import { destroyCustomerSession, PORTAL_COOKIE, readCookie, sessionCookie } from "@/server/auth/session";
export const POST = publicApi(async (req) => {
  await destroyCustomerSession(readCookie(req.headers.get("cookie"), PORTAL_COOKIE));
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(PORTAL_COOKIE, "", 0) });
});
