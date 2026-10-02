import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG ? ["query", "error", "warn"] : process.env.NODE_ENV === "test" ? [] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Tx = Prisma.TransactionClient;

/**
 * Run a unit of work in a READ COMMITTED transaction. Balance-changing code
 * takes explicit row locks (SELECT ... FOR UPDATE) in a deterministic order,
 * which is what prevents lost updates / double spend.
 */
export function withTx<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
  return prisma.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 15_000,
    timeout: opts?.timeout ?? 30_000,
  });
}

export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    if (!field) return true;
    const target = (e.meta?.target ?? []) as string[] | string;
    return Array.isArray(target) ? target.includes(field) : String(target).includes(field);
  }
  return false;
}

export async function nextSeq(tx: Tx | PrismaClient, name: string): Promise<bigint> {
  if (!/^nb_[a-z_]+_seq$/.test(name)) throw new Error("bad sequence");
  const rows = await tx.$queryRawUnsafe<{ v: bigint }[]>(`SELECT nextval('${name}') AS v`);
  return BigInt(rows[0].v);
}
