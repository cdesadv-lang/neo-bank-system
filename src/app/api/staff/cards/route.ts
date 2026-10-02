import { prisma } from "@/lib/db";
import { staffApi } from "@/server/http";
import { issueCard } from "@/server/services/cards";
import { branchWhere } from "@/server/rbac";
export const GET = staffApi("card.read", async (_req, { staff }) => prisma.card.findMany({ where: { account: branchWhere(staff) }, include: { customer: true, account: true }, orderBy: { createdAt: "desc" }, take: 300, omit: { token: true, pinVerificationValue: true } }));
export const POST = staffApi("card.manage", async (req, { staff, actor }) => issueCard(staff, actor, await req.json()));
