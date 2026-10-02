import { z } from "zod";
import { publicApi, parseBody, json } from "@/server/http";
import { customerLoginVerify } from "@/server/auth/login";
import { PORTAL_COOKIE, sessionCookie } from "@/server/auth/session";
const schema = z.object({ username: z.string(), challengeId: z.string(), code: z.string().regex(/^\d{6}$/) });
export const POST = publicApi(async (req, { ip, ua }) => {
  const s = await customerLoginVerify(await parseBody(req, schema), ip, ua);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(PORTAL_COOKIE, s.token, s.maxAge) });
});
