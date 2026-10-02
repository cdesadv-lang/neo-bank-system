"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type Field = {
  name: string;
  label: string;
  type?: "text" | "number" | "password" | "select" | "checkbox" | "textarea" | "date" | "hidden" | "json";
  options?: { value: string; label: string }[];
  required?: boolean;
  defaultValue?: string | boolean;
  placeholder?: string;
  ltr?: boolean;
  wide?: boolean;
};

function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = v;
}

export async function callApi(endpoint: string, method: string, body?: unknown) {
  const res = await fetch(endpoint, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } })?.error;
    throw new Error(err?.message ? `${err.message}${err.code ? ` (${err.code})` : ""}` : `HTTP ${res.status}`);
  }
  return data;
}

const inputCls = "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
export const btnCls = "rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50";
export const btnGhost = "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50";

function FieldInput({ f }: { f: Field }) {
  const common = { name: f.name, required: f.required, placeholder: f.placeholder, dir: f.ltr ? "ltr" : undefined } as const;
  if (f.type === "hidden") return <input type="hidden" name={f.name} defaultValue={String(f.defaultValue ?? "")} />;
  if (f.type === "select") return <select {...common} className={inputCls} defaultValue={String(f.defaultValue ?? "")}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  if (f.type === "checkbox") return <input type="checkbox" name={f.name} defaultChecked={!!f.defaultValue} className="h-4 w-4" />;
  if (f.type === "textarea" || f.type === "json") return <textarea {...common} rows={f.type === "json" ? 4 : 3} className={`${inputCls} ${f.type === "json" ? "font-mono text-xs" : ""}`} defaultValue={String(f.defaultValue ?? "")} dir={f.type === "json" ? "ltr" : common.dir} />;
  return <input {...common} type={f.type === "number" ? "text" : (f.type ?? "text")} inputMode={f.type === "number" ? "decimal" : undefined} className={inputCls} defaultValue={String(f.defaultValue ?? "")} dir={f.type === "number" || f.type === "password" || f.ltr ? "ltr" : undefined} />;
}

/**
 * Generic form → JSON API. Adds an idempotency key per submission when `idempotent` (re-submits after a
 * network error reuse the same key, so the server never double-posts).
 */
export function ApiForm({ endpoint, method = "POST", fields, extra, submitLabel, idempotent, onDone, confirm, compact, showResult = true, resetOnSuccess = true }: {
  endpoint: string; method?: string; fields: Field[]; extra?: Record<string, unknown>; submitLabel: string; idempotent?: boolean;
  onDone?: "refresh" | { redirect: string } | "none"; confirm?: string; compact?: boolean; showResult?: boolean; resetOnSuccess?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; data?: unknown } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const body: Record<string, unknown> = { ...(extra ?? {}) };
    try {
      for (const f of fields) {
        if (f.type === "checkbox") { setPath(body, f.name, fd.get(f.name) === "on"); continue; }
        const v = fd.get(f.name);
        if (v === null || v === "") continue;
        setPath(body, f.name, f.type === "json" ? JSON.parse(String(v)) : String(v));
      }
    } catch { setMsg({ ok: false, text: "Invalid JSON" }); return; }
    if (idempotent) body.idempotencyKey = key;
    setBusy(true);
    setMsg(null);
    try {
      const data = await callApi(endpoint, method, method === "GET" ? undefined : body);
      setMsg({ ok: true, text: "✓", data });
      setKey(crypto.randomUUID());
      if (resetOnSuccess) form.reset();
      if (onDone && typeof onDone === "object") router.push(onDone.redirect);
      else if (onDone !== "none") router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className={compact ? "flex flex-wrap items-end gap-2" : "space-y-3"}>
      <div className={compact ? "contents" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
        {fields.map((f) => f.type === "hidden" ? <FieldInput key={f.name} f={f} /> : (
          <label key={f.name} className={`block text-xs text-slate-600 ${f.wide ? "sm:col-span-2" : ""} ${f.type === "checkbox" ? "flex items-center gap-2" : ""}`}>
            <span className={f.type === "checkbox" ? "order-2" : "mb-1 block"}>{f.label}{f.required ? " *" : ""}</span>
            <FieldInput f={f} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={busy} className={btnCls}>{busy ? "…" : submitLabel}</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</span>}
      </div>
      {showResult && msg?.ok && msg.data !== undefined && <ResultView data={msg.data} />}
    </form>
  );
}

function ResultView({ data }: { data: unknown }) {
  const d = data as Record<string, unknown> | null;
  if (d && typeof d === "object" && "devCode" in d && d.devCode) {
    return <div className="rounded bg-amber-50 p-2 text-xs text-amber-900">DEMO OTP: <b dir="ltr">{String(d.devCode)}</b></div>;
  }
  return <details className="text-xs"><summary className="cursor-pointer text-slate-500">result</summary><pre dir="ltr" className="max-h-56 overflow-auto rounded bg-slate-900 p-2 text-slate-100">{JSON.stringify(data, null, 2)}</pre></details>;
}

/** One-click action (POST with a fixed body). */
export function ActionButton({ endpoint, body, label, confirm, tone = "primary", method = "POST", redirect, prompt }: {
  endpoint: string; body?: Record<string, unknown>; label: string; confirm?: string; tone?: "primary" | "ghost" | "danger"; method?: string; redirect?: string;
  prompt?: { field: string; label: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cls = tone === "danger" ? "rounded-md bg-rose-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-800 disabled:opacity-50" : tone === "ghost" ? "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50" : "rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50";
  return (
    <span className="inline-flex flex-col">
      <button type="button" disabled={busy} className={cls} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        const b: Record<string, unknown> = { ...(body ?? {}) };
        if (prompt) {
          const v = window.prompt(prompt.label);
          if (v === null) return;
          b[prompt.field] = v;
        }
        setBusy(true); setErr(null);
        try {
          await callApi(endpoint, method, method === "DELETE" ? undefined : b);
          if (redirect) router.push(redirect); else router.refresh();
        } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? "…" : label}</button>
      {err && <span className="mt-1 max-w-56 text-xs text-rose-700">{err}</span>}
    </span>
  );
}

/** Two-step OTP flow: start → shows preview + OTP box → confirm. */
export function OtpFlow({ startEndpoint, confirmEndpoint, fields, labels, idempotent }: {
  startEndpoint: string; confirmEndpoint: string; fields: Field[]; idempotent?: boolean;
  labels: { start: string; confirm: string; code: string; sent: string; done: string; cancel: string };
}) {
  const router = useRouter();
  const [stage, setStage] = useState<{ challengeId: string; preview?: unknown; devCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const f of fields) { const v = fd.get(f.name); if (v !== null && v !== "") setPath(body, f.name, String(v)); }
    if (idempotent) body.idempotencyKey = key;
    setBusy(true); setMsg(null);
    try {
      const r = (await callApi(startEndpoint, "POST", body)) as { challengeId: string; preview?: unknown; devCode?: string };
      setStage(r);
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  }
  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    setBusy(true); setMsg(null);
    try {
      await callApi(confirmEndpoint, "POST", { challengeId: stage!.challengeId, code });
      setMsg({ ok: true, text: labels.done });
      setStage(null);
      setKey(crypto.randomUUID());
      router.refresh();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      {!stage ? (
        <form onSubmit={start} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((f) => <label key={f.name} className={`block text-xs text-slate-600 ${f.wide ? "sm:col-span-2" : ""}`}><span className="mb-1 block">{f.label}{f.required ? " *" : ""}</span><FieldInput f={f} /></label>)}
          </div>
          <button disabled={busy} className={btnCls}>{busy ? "…" : labels.start}</button>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm text-sky-900">{labels.sent}</p>
          {stage.preview !== undefined && <pre dir="ltr" className="overflow-auto rounded bg-white p-2 text-xs">{JSON.stringify(stage.preview, null, 2)}</pre>}
          {stage.devCode && <div className="text-xs text-amber-800">DEMO OTP: <b dir="ltr">{stage.devCode}</b></div>}
          <label className="block text-xs text-slate-600"><span className="mb-1 block">{labels.code}</span>
            <input name="code" required inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" dir="ltr" className={`${inputCls} max-w-40 tracking-widest`} />
          </label>
          <div className="flex gap-2">
            <button disabled={busy} className={btnCls}>{busy ? "…" : labels.confirm}</button>
            <button type="button" className={btnGhost} onClick={() => setStage(null)}>{labels.cancel}</button>
          </div>
        </form>
      )}
      {msg && <div className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}
    </div>
  );
}

export function LangToggle({ lang }: { lang: "ar" | "en" }) {
  const router = useRouter();
  return (
    <button type="button" className="rounded-md border border-white/30 px-2 py-1 text-xs hover:bg-white/10" onClick={() => {
      document.cookie = `lang=${lang === "ar" ? "en" : "ar"}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    }}>{lang === "ar" ? "English" : "العربية"}</button>
  );
}

export function LogoutButton({ endpoint, redirect, label }: { endpoint: string; redirect: string; label: string }) {
  const router = useRouter();
  return <button type="button" className="rounded-md border border-white/30 px-2 py-1 text-xs hover:bg-white/10" onClick={async () => { await fetch(endpoint, { method: "POST" }); router.push(redirect); router.refresh(); }}>{label}</button>;
}

/** Keeps a server-rendered view live (card authorizations, notifications) without a websocket. */
export function AutoRefresh({ seconds = 5, label }: { seconds?: number; label?: string }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [on, seconds, router]);
  return <label className="inline-flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />{label ?? "live"} ({seconds}s)</label>;
}

export function Tabs({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [cur, setCur] = useState(tabs[0]?.id);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((t) => <button key={t.id} type="button" onClick={() => setCur(t.id)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${cur === t.id ? "border-sky-700 font-semibold text-sky-800" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t.label}</button>)}
      </div>
      {tabs.find((t) => t.id === cur)?.content}
    </div>
  );
}
