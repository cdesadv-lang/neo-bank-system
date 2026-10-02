import { publicApi, json } from "@/server/http";
import { destroyStaffSession, readCookie, sessionCookie, STAFF_COOKIE } from "@/server/auth/session";
export const POST = publicApi(async (req) => {
  await destroyStaffSession(readCookie(req.headers.get("cookie"), STAFF_COOKIE));
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(STAFF_COOKIE, "", 0) });
});
