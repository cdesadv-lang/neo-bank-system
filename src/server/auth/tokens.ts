import { createHmac, randomBytes } from "crypto";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET must be set (>=32 chars)");
    return "dev-only-insecure-session-secret-change-me-please";
  }
  return s;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored only as keyed hashes; a DB leak does not expose live sessions. */
export function hashToken(token: string): string {
  return createHmac("sha256", secret()).update(token).digest("hex");
}

export function hashOtp(code: string, subject: string): string {
  return createHmac("sha256", secret()).update(`otp:${subject}:${code}`).digest("hex");
}
