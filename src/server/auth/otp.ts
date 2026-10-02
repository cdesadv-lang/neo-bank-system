import { randomInt } from "crypto";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hashOtp } from "./tokens";

/** Pluggable OTP delivery. */
export interface OtpProvider {
  name: string;
  send(phone: string, code: string, purpose: string): Promise<void>;
}

/** DEV ONLY: prints codes to the server console. */
export const consoleProvider: OtpProvider = {
  name: "console",
  async send(phone, code, purpose) {
    console.log(`\n[DEV OTP] ${purpose} code for ${phone}: ${code}\n`);
  },
};

/** Test provider: keeps the last code per phone in memory. */
export const memoryOutbox = new Map<string, string>();
export const memoryProvider: OtpProvider = {
  name: "memory",
  async send(phone, code) {
    memoryOutbox.set(phone, code);
  },
};

/** Generic SMS gateway adapter: POSTs JSON to SMS_WEBHOOK_URL (wire to your SMS aggregator). */
export const smsWebhookProvider: OtpProvider = {
  name: "sms-webhook",
  async send(phone, code, purpose) {
    const url = process.env.SMS_WEBHOOK_URL;
    if (!url) throw new Error("SMS_WEBHOOK_URL not configured");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN ?? ""}` },
      body: JSON.stringify({ to: phone, message: `Neo Bank code: ${code} (${purpose}). Never share it.` }),
    });
    if (!res.ok) throw new Error(`SMS gateway error ${res.status}`);
  },
};

export function getOtpProvider(): OtpProvider {
  const p = process.env.OTP_PROVIDER ?? "console";
  if (p === "memory") return memoryProvider;
  if (p === "sms-webhook") return smsWebhookProvider;
  if (process.env.NODE_ENV === "production" && p === "console" && process.env.ALLOW_CONSOLE_OTP !== "1") {
    throw new Error("Console OTP provider is disabled in production; configure OTP_PROVIDER");
  }
  return consoleProvider;
}

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export async function issueOtp(opts: { subject: string; phone: string; purpose: string; payload?: unknown }) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Invalidate previous open challenges for the same purpose.
  await prisma.otpChallenge.updateMany({ where: { subject: opts.subject, purpose: opts.purpose, consumedAt: null }, data: { consumedAt: new Date() } });
  const ch = await prisma.otpChallenge.create({
    data: {
      subject: opts.subject,
      purpose: opts.purpose,
      codeHash: hashOtp(code, opts.subject),
      payload: (opts.payload ?? undefined) as object | undefined,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });
  await getOtpProvider().send(opts.phone, code, opts.purpose);
  return { challengeId: ch.id, expiresAt: ch.expiresAt };
}

/** Verifies and consumes a challenge atomically. Returns the stored payload. */
export async function verifyOtp(challengeId: string, subject: string, purpose: string, code: string): Promise<unknown> {
  const ch = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
  if (!ch || ch.subject !== subject || ch.purpose !== purpose) throw new AppError("OTP_INVALID", 401, "Invalid or expired code");
  if (ch.consumedAt || ch.expiresAt < new Date()) throw new AppError("OTP_EXPIRED", 401, "Code expired, request a new one");
  if (ch.attempts >= MAX_ATTEMPTS) throw new AppError("OTP_LOCKED", 429, "Too many attempts");
  if (ch.codeHash !== hashOtp(String(code), subject)) {
    await prisma.otpChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    throw new AppError("OTP_INVALID", 401, "Invalid code");
  }
  // consume (guard against concurrent double-use)
  const r = await prisma.otpChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (r.count !== 1) throw new AppError("OTP_EXPIRED", 401, "Code already used");
  return ch.payload;
}
