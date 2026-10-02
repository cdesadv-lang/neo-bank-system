import { prisma, Tx } from "@/lib/db";

export async function notify(db: Tx | typeof prisma, customerId: string, n: { titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; createdAt?: Date }) {
  await db.notification.create({ data: { customerId, ...n } });
}
