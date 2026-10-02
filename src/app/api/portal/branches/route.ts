import { prisma } from "@/lib/db";
import { publicApi } from "@/server/http";
export const GET = publicApi(async () => prisma.branch.findMany({ where: { active: true }, select: { code: true, nameAr: true, nameEn: true, city: true } }));
