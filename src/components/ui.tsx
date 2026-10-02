import Link from "next/link";
import type { ReactNode } from "react";
import { minorToString } from "@/lib/money";
import { STATUS_AR, type Lang } from "@/lib/i18n";

export function money(v: bigint | number | string | null | undefined, ccy = "EGP") {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "bigint" ? v : BigInt(String(v));
  const s = minorToString(n);
  const [i, f] = s.replace("-", "").split(".");
  return `${n < 0n ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f ?? "00"} ${ccy}`;
}

export function dt(d: Date | string | null | undefined, withTime = true) {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className = "", actions }: { title?: string; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="font-semibold text-slate-800">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = "slate" }: { label: string; value: ReactNode; hint?: string; tone?: "slate" | "green" | "red" | "amber" | "blue" }) {
  const tones = { slate: "text-slate-900", green: "text-emerald-700", red: "text-rose-700", amber: "text-amber-700", blue: "text-sky-700" };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tones[tone]}`} dir="ltr">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800", APPROVED: "bg-emerald-100 text-emerald-800", COMPLETED: "bg-emerald-100 text-emerald-800", POSTED: "bg-emerald-100 text-emerald-800",
  CAPTURED: "bg-emerald-100 text-emerald-800", SETTLED: "bg-emerald-100 text-emerald-800", ONLINE: "bg-emerald-100 text-emerald-800", RESOLVED_CUSTOMER: "bg-emerald-100 text-emerald-800",
  PENDING: "bg-amber-100 text-amber-800", AUTHORIZED: "bg-amber-100 text-amber-800", OPEN: "bg-amber-100 text-amber-800", PENDING_3DS: "bg-amber-100 text-amber-800", IN_REVIEW: "bg-amber-100 text-amber-800",
  FROZEN: "bg-sky-100 text-sky-800", RELEASED: "bg-slate-100 text-slate-700", REFUNDED: "bg-sky-100 text-sky-800", PARTIALLY_REFUNDED: "bg-sky-100 text-sky-800", CHARGEBACK_RAISED: "bg-sky-100 text-sky-800",
  DECLINED: "bg-rose-100 text-rose-800", REJECTED: "bg-rose-100 text-rose-800", FAILED: "bg-rose-100 text-rose-800", BLOCKED: "bg-rose-100 text-rose-800", REVERSED: "bg-rose-100 text-rose-800",
  CLOSED: "bg-slate-200 text-slate-700", OFFLINE: "bg-rose-100 text-rose-800", HIGH: "bg-rose-100 text-rose-800", MEDIUM: "bg-amber-100 text-amber-800", LOW: "bg-emerald-100 text-emerald-800",
};
export function Badge({ v, lang }: { v: string | null | undefined; lang?: Lang }) {
  if (!v) return <span>—</span>;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[v] ?? "bg-slate-100 text-slate-700"}`}>{lang === "ar" ? (STATUS_AR[v] ?? v) : v}</span>;
}

export type Col<T> = { h: string; c: (row: T) => ReactNode; className?: string };
export function Table<T>({ rows, cols, empty = "—", rowKey }: { rows: T[]; cols: Col<T>[]; empty?: string; rowKey?: (r: T, i: number) => string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-start text-xs uppercase text-slate-500">
            {cols.map((c, i) => <th key={i} className="whitespace-nowrap px-2 py-2 text-start font-medium">{c.h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-slate-400">{empty}</td></tr>}
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i} className="border-b border-slate-100 hover:bg-slate-50">
              {cols.map((c, j) => <td key={j} className={`px-2 py-2 align-top ${c.className ?? ""}`}>{c.c(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="text-sky-700 hover:underline">{children}</Link>;
}

export function Ltr({ children }: { children: ReactNode }) {
  return <span dir="ltr" className="font-mono text-[13px]">{children}</span>;
}

export function Grid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const c = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-2 lg:grid-cols-4" }[cols];
  return <div className={`grid grid-cols-1 gap-4 ${c}`}>{children}</div>;
}

export function Notice({ children, tone = "amber" }: { children: ReactNode; tone?: "amber" | "sky" | "rose" }) {
  const t = { amber: "border-amber-300 bg-amber-50 text-amber-900", sky: "border-sky-300 bg-sky-50 text-sky-900", rose: "border-rose-300 bg-rose-50 text-rose-900" }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${t}`}>{children}</div>;
}

export function Json({ v }: { v: unknown }) {
  return <pre dir="ltr" className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)}</pre>;
}
