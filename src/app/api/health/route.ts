import { prisma } from "@/lib/db";
import { json } from "@/server/http";
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch {
    return json({ ok: false, db: "down" }, 503);
  }
}
