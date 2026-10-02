import bcrypt from "bcryptjs";

export const PASSWORD_POLICY = {
  minLength: 10,
  description: "≥10 chars, upper & lower case letters, a digit and a symbol",
};

export function checkPasswordPolicy(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < PASSWORD_POLICY.minLength) return "Password must be at least 10 characters";
  if (pw.length > 128) return "Password too long";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "Password needs upper and lower case letters";
  if (!/\d/.test(pw)) return "Password needs a digit";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password needs a symbol";
  return null;
}

const COST = process.env.NODE_ENV === "test" ? 4 : 12;
export const hashPassword = (pw: string) => bcrypt.hash(pw, COST);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** Constant-ish time dummy compare to avoid user enumeration via timing. */
const DUMMY = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5Yh1Yv4x6l6b6JqO0Q5Yh1Yv4x6l6b6";
export async function dummyVerify() {
  await bcrypt.compare("x", DUMMY).catch(() => false);
}
