import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
export const GET = staffApi("clearing.manage", async () => prisma.clearingBatch.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { transfers: true } }));
