import { prisma } from "@/lib/db";
import type { StaffPrincipal } from "@/server/rbac";
import { hashToken, newToken } from "./tokens";

export const STAFF_COOKIE = "nb_staff";
export const PORTAL_COOKIE = "nb_portal";

const STAFF_ABSOLUTE_MS = 8 * 3600_000;
const STAFF_IDLE_MS = 30 * 60_000;
const CUSTOMER_ABSOLUTE_MS = 2 * 3600_000;
const CUSTOMER_IDLE_MS = 15 * 60_000;

export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "false") return false;
  if (process.env.COOKIE_SECURE === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function sessionCookie(name: string, value: string, maxAgeSec: number) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function createStaffSession(staffId: string, ip?: string, ua?: string) {
  const token = newToken();
  await prisma.staffSession.create({
    data: { tokenHash: hashToken(token), staffId, ip, userAgent: ua?.slice(0, 300), expiresAt: new Date(Date.now() + STAFF_ABSOLUTE_MS) },
  });
  return { token, maxAge: STAFF_ABSOLUTE_MS / 1000 };
}

export async function getStaffByToken(token: string | null | undefined): Promise<(StaffPrincipal & { sessionId: string }) | null> {
  if (!token) return null;
  const s = await prisma.staffSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { staff: true } });
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() < now || now - s.lastSeenAt.getTime() > STAFF_IDLE_MS || !s.staff.active) {
    await prisma.staffSession.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 60_000) {
    await prisma.staffSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  const st = s.staff;
  return { sessionId: s.id, id: st.id, username: st.username, role: st.role, branchId: st.branchId, fullNameEn: st.fullNameEn, fullNameAr: st.fullNameAr };
}

export async function destroyStaffSession(token: string | null) {
  if (token) await prisma.staffSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type CustomerPrincipal = {
  userId: string;
  customerId: string;
  cif: string;
  nameAr: string;
  nameEn: string;
  phone: string;
  branchId: string;
  kycStatus: string;
};

export async function createCustomerSession(userId: string, ip?: string, ua?: string) {
  const token = newToken();
  await prisma.customerSession.create({
    data: { tokenHash: hashToken(token), userId, ip, userAgent: ua?.slice(0, 300), expiresAt: new Date(Date.now() + CUSTOMER_ABSOLUTE_MS) },
  });
  return { token, maxAge: CUSTOMER_ABSOLUTE_MS / 1000 };
}

export async function getCustomerByToken(token: string | null | undefined): Promise<CustomerPrincipal | null> {
  if (!token) return null;
  const s = await prisma.customerSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { include: { customer: true } } } });
  if (!s) return null;
  const now = Date.now();
  const c = s.user.customer;
  if (s.expiresAt.getTime() < now || now - s.lastSeenAt.getTime() > CUSTOMER_IDLE_MS || !s.user.active || c.status !== "ACTIVE") {
    await prisma.customerSession.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 60_000) {
    await prisma.customerSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { userId: s.userId, customerId: c.id, cif: c.cif, nameAr: c.nameAr, nameEn: c.nameEn, phone: c.phone, branchId: c.branchId, kycStatus: c.kycStatus };
}

export async function destroyCustomerSession(token: string | null) {
  if (token) await prisma.customerSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}
