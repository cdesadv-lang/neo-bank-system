import { z } from "zod";
import { publicApi, parseBody, json } from "@/server/http";
import { staffLogin } from "@/server/auth/login";
import { sessionCookie, STAFF_COOKIE } from "@/server/auth/session";
const schema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200), totp: z.string().max(10).optional() });
export const POST = publicApi(async (req, { ip, ua }) => {
  const body = await parseBody(req, schema);
  const r = await staffLogin(body, ip, ua);
  return json({ ok: true, staff: r.staff }, 200, { "set-cookie": sessionCookie(STAFF_COOKIE, r.token, r.maxAge) });
});
