import { z } from "zod";
import { prisma } from "@/lib/db";
import { staffApi, parseBody } from "@/server/http";
import { runEod } from "@/server/services/eod";
import { todayStr } from "@/lib/dates";
export const GET = staffApi("eod.run", async () => prisma.eodRun.findMany({ orderBy: { businessDate: "desc" }, take: 60 }));
export const POST = staffApi("eod.run", async (req, { staff, actor }) => {
  const b = await parseBody(req, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  return runEod(b.date ?? todayStr(), { actor, staffId: staff.id });
});
