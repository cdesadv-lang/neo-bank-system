import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { publicApi, parseBody } from "@/server/http";
import { handleIso } from "@/server/switch/adapter";
import { enforceRateLimit } from "@/server/auth/ratelimit";
/**
 * Issuer host endpoint for an external ATM/POS switch (JSON-encoded ISO 8583).
 * Authenticated with a shared key (x-switch-key). In production put this on a private
 * network link / mTLS with the switch provider; never expose it publicly.
 */
const schema = z.object({ mti: z.string().regex(/^0[1-4][0-3]0$/), fields: z.record(z.string(), z.string()) });
function keyOk(req: Request) {
  const expected = process.env.SWITCH_API_KEY ?? (process.env.NODE_ENV === "production" ? "" : "dev-switch-key-change-me");
  const got = req.headers.get("x-switch-key") ?? "";
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
export const POST = publicApi(async (req, { ip }) => {
  if (!keyOk(req)) throw new AppError("UNAUTHORIZED", 401, "Invalid switch key");
  await enforceRateLimit(`switch:${ip}`, 600, 60);
  return handleIso(await parseBody(req, schema));
});
