import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { audit } from "@/server/audit";
import { dummyVerify, verifyPassword } from "./password";
import { enforceRateLimit } from "./ratelimit";
import { verifyTotp } from "./totp";
import { createCustomerSession, createStaffSession } from "./session";
import { issueOtp, verifyOtp } from "./otp";

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;
const invalid = () => new AppError("INVALID_CREDENTIALS", 401, "Invalid username or password");

export async function staffLogin(input: { username: string; password: string; totp?: string }, ip = "unknown", ua = "") {
  const username = String(input.username ?? "").trim().toLowerCase();
  await enforceRateLimit(`staff-login:ip:${ip}`, 30, 900);
  await enforceRateLimit(`staff-login:user:${username}`, 10, 900);

  const staff = await prisma.staff.findUnique({ where: { username } });
  if (!staff || !staff.active) {
    await dummyVerify();
    await audit({ type: "ANONYMOUS", name: username, ip, userAgent: ua }, "STAFF_LOGIN_FAILED", { type: "Staff" });
    throw invalid();
  }
  if (staff.lockedUntil && staff.lockedUntil > new Date()) {
    throw new AppError("ACCOUNT_LOCKED", 423, "Account locked after repeated failures. Try again later.");
  }
  const ok = await verifyPassword(String(input.password ?? ""), staff.passwordHash);
  if (!ok) {
    const failed = staff.failedLogins + 1;
    await prisma.staff.update({
      where: { id: staff.id },
      data: { failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null },
    });
    await audit({ type: "STAFF", id: staff.id, name: staff.username, ip, userAgent: ua }, failed >= MAX_FAILED ? "STAFF_LOCKED" : "STAFF_LOGIN_FAILED", { type: "Staff", id: staff.id });
    throw invalid();
  }
  if (staff.totpEnabled) {
    if (!input.totp) throw new AppError("TOTP_REQUIRED", 401, "Two-factor code required");
    if (!staff.totpSecret || !verifyTotp(staff.totpSecret, String(input.totp))) {
      await prisma.staff.update({ where: { id: staff.id }, data: { failedLogins: { increment: 1 } } });
      throw new AppError("TOTP_INVALID", 401, "Invalid two-factor code");
    }
  }
  await prisma.staff.update({ where: { id: staff.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const session = await createStaffSession(staff.id, ip, ua);
  await audit({ type: "STAFF", id: staff.id, name: staff.username, ip, userAgent: ua }, "STAFF_LOGIN", { type: "Staff", id: staff.id });
  return { ...session, staff: { id: staff.id, username: staff.username, role: staff.role, branchId: staff.branchId } };
}

/** Step 1: username + password. On success an OTP is sent to the registered mobile. */
export async function customerLoginStart(input: { username: string; password: string }, ip = "unknown", ua = "") {
  const username = String(input.username ?? "").trim().toLowerCase();
  await enforceRateLimit(`cust-login:ip:${ip}`, 30, 900);
  await enforceRateLimit(`cust-login:user:${username}`, 10, 900);
  const user = await prisma.customerUser.findUnique({ where: { username }, include: { customer: true } });
  if (!user || !user.active || user.customer.status !== "ACTIVE") {
    await dummyVerify();
    throw invalid();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError("ACCOUNT_LOCKED", 423, "Account locked after repeated failures. Try again later.");
  const ok = await verifyPassword(String(input.password ?? ""), user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.customerUser.update({
      where: { id: user.id },
      data: { failedLogins: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : null },
    });
    await audit({ type: "CUSTOMER", id: user.customerId, name: username, ip, userAgent: ua }, failed >= MAX_FAILED ? "CUSTOMER_LOCKED" : "CUSTOMER_LOGIN_FAILED", { type: "Customer", id: user.customerId });
    throw invalid();
  }
  const otp = await issueOtp({ subject: user.id, phone: user.customer.phone, purpose: "LOGIN" });
  return { challengeId: otp.challengeId, expiresAt: otp.expiresAt, phoneHint: user.customer.phone.replace(/.(?=.{3})/g, "•"), devCode: otp.devCode };
}

/** Step 2: verify OTP, create session. */
export async function customerLoginVerify(input: { username: string; challengeId: string; code: string }, ip = "unknown", ua = "") {
  const username = String(input.username ?? "").trim().toLowerCase();
  await enforceRateLimit(`cust-otp:ip:${ip}`, 30, 900);
  const user = await prisma.customerUser.findUnique({ where: { username } });
  if (!user) throw new AppError("OTP_INVALID", 401, "Invalid code");
  await verifyOtp(String(input.challengeId), user.id, "LOGIN", String(input.code));
  await prisma.customerUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const session = await createCustomerSession(user.id, ip, ua);
  await audit({ type: "CUSTOMER", id: user.customerId, name: username, ip, userAgent: ua }, "CUSTOMER_LOGIN", { type: "Customer", id: user.customerId });
  return session;
}
