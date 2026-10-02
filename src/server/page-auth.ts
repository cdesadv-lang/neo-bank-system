import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LANG_COOKIE, type Lang } from "@/lib/i18n";
import { getCustomerByToken, getStaffByToken, PORTAL_COOKIE, STAFF_COOKIE } from "@/server/auth/session";
import { can, type Permission } from "@/server/rbac";

export async function getLang(): Promise<Lang> {
  const c = await cookies();
  return c.get(LANG_COOKIE)?.value === "en" ? "en" : "ar";
}

/** Server-component guard for staff pages. Permission checks are also enforced again in every service/API. */
export async function requireStaffPage(perm?: Permission) {
  const c = await cookies();
  const staff = await getStaffByToken(c.get(STAFF_COOKIE)?.value);
  if (!staff) redirect("/staff/login");
  const lang = await getLang();
  if (perm && !can(staff, perm)) redirect("/staff?denied=" + encodeURIComponent(perm));
  return { staff, lang };
}

export async function getStaffOptional() {
  const c = await cookies();
  return getStaffByToken(c.get(STAFF_COOKIE)?.value);
}

export async function requireCustomerPage() {
  const c = await cookies();
  const customer = await getCustomerByToken(c.get(PORTAL_COOKIE)?.value);
  if (!customer) redirect("/portal/login");
  return { customer, lang: await getLang() };
}
