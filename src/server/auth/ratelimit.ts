import { prisma } from "@/lib/db";
import { Errors } from "@/lib/errors";

/**
 * Fixed-window rate limiter backed by PostgreSQL (works across multiple app instances).
 * Atomic upsert: resets the window when expired, otherwise increments.
 */
export async function hitRateLimit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; count: number }> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" (key, "windowStart", count) VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSec}) THEN 1 ELSE "RateLimitBucket".count + 1 END,
      "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSec}) THEN now() ELSE "RateLimitBucket"."windowStart" END
    RETURNING count`;
  const count = Number(rows[0].count);
  return { allowed: count <= limit, count };
}

export async function enforceRateLimit(key: string, limit: number, windowSec: number) {
  if (process.env.DISABLE_RATE_LIMIT === "1" && process.env.NODE_ENV !== "production") return;
  const r = await hitRateLimit(key, limit, windowSec);
  if (!r.allowed) throw Errors.rateLimited();
}
