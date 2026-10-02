import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError } from "@/lib/errors";
import { jsonSafe } from "@/lib/money";
import type { Actor } from "./audit";
import { can, type Permission, type StaffPrincipal } from "./rbac";
import { getCustomerByToken, getStaffByToken, PORTAL_COOKIE, readCookie, STAFF_COOKIE, type CustomerPrincipal } from "./auth/session";

export type RouteCtx = { params: Promise<Record<string, string>> };

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(jsonSafe(data), { status, headers: { "cache-control": "no-store", ...headers } });
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);
  if (e instanceof ZodError) return json({ error: { code: "VALIDATION_ERROR", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), details: e.issues } }, 422);
  if (e instanceof SyntaxError) return json({ error: { code: "BAD_REQUEST", message: "Malformed JSON" } }, 400);
  console.error("[api] unhandled error", e);
  return json({ error: { code: "INTERNAL_ERROR", message: "Unexpected error" } }, 500);
}

/** CSRF defence in depth: SameSite=Strict cookies + reject cross-origin state-changing requests. */
function checkOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw new AppError("CSRF_REJECTED", 403, "Cross-origin request rejected");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("CSRF_REJECTED", 403, "Bad origin");
  }
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  const data = text ? JSON.parse(text) : {};
  return schema.parse(data);
}

type Handler<C> = (req: Request, ctx: C) => Promise<unknown>;

export function publicApi(fn: Handler<{ params: Record<string, string>; ip: string; ua: string }>) {
  return async (req: Request, rc?: RouteCtx) => {
    try {
      checkOrigin(req);
      const params = rc?.params ? await rc.params : {};
      const out = await fn(req, { params, ip: clientIp(req), ua: req.headers.get("user-agent") ?? "" });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export type StaffCtx = { staff: StaffPrincipal; actor: Actor; params: Record<string, string>; ip: string };

/** Every staff API goes through here: session check + permission check, server-side. */
export function staffApi(perm: Permission | null, fn: Handler<StaffCtx>) {
  return async (req: Request, rc?: RouteCtx) => {
    try {
      checkOrigin(req);
      const staff = await getStaffByToken(readCookie(req.headers.get("cookie"), STAFF_COOKIE));
      if (!staff) throw new AppError("UNAUTHORIZED", 401, "Staff authentication required");
      if (perm && !can(staff, perm)) throw new AppError("FORBIDDEN", 403, `Role ${staff.role} lacks permission ${perm}`);
      const ip = clientIp(req);
      const params = rc?.params ? await rc.params : {};
      const actor: Actor = { type: "STAFF", id: staff.id, name: staff.username, ip, userAgent: req.headers.get("user-agent") };
      const out = await fn(req, { staff, actor, params, ip });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export type PortalCtx = { customer: CustomerPrincipal; actor: Actor; params: Record<string, string>; ip: string };

/** Every portal API: customer session required; all queries are then scoped to customer.customerId. */
export function portalApi(fn: Handler<PortalCtx>) {
  return async (req: Request, rc?: RouteCtx) => {
    try {
      checkOrigin(req);
      const customer = await getCustomerByToken(readCookie(req.headers.get("cookie"), PORTAL_COOKIE));
      if (!customer) throw new AppError("UNAUTHORIZED", 401, "Customer authentication required");
      const ip = clientIp(req);
      const params = rc?.params ? await rc.params : {};
      const actor: Actor = { type: "CUSTOMER", id: customer.customerId, name: customer.cif, ip, userAgent: req.headers.get("user-agent") };
      const out = await fn(req, { customer, actor, params, ip });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
