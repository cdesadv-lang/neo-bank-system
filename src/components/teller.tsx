"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnCls, btnGhost, callApi } from "./client";

type Count = { id: string; total: string; noteCount: number; suspectedCounterfeits: number; denominations: Record<string, number>; currency: string };
const input = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";

/** Pull a count from a cash-counting device (simulator / TCP / serial). */
export function CountPanel({ devices, purpose, tillId, onCount, t }: { devices: { deviceId: string; label: string }[]; purpose: string; tillId?: string; onCount: (c: Count) => void; t: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sim, setSim] = useState("");
  const [cf, setCf] = useState("0");
  const [last, setLast] = useState<Count | null>(null);
  if (!devices.length) return <p className="text-xs text-slate-500">{t.noDevice}</p>;
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-slate-300 p-3">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label>{t.device}<select id="dev" className={input}>{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select></label>
        <label>{t.simNotes}<input value={sim} onChange={(e) => setSim(e.target.value)} placeholder="20000:5,10000:3" dir="ltr" className={input} /></label>
        <label>{t.counterfeits}<input value={cf} onChange={(e) => setCf(e.target.value)} dir="ltr" className={`${input} w-16`} /></label>
        <button type="button" disabled={busy} className={btnGhost} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            const deviceId = (document.getElementById("dev") as HTMLSelectElement).value;
            const denominations = sim ? Object.fromEntries(sim.split(",").map((p) => p.split(":").map((x) => x.trim())).map(([d, n]) => [d, Number(n)])) : undefined;
            const r = (await callApi("/api/staff/devices/count", "POST", { deviceId, purpose, tillId, simulate: { denominations, counterfeits: Number(cf) || 0 } })) as Count;
            setLast(r); onCount(r);
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "…" : t.pull}</button>
      </div>
      {err && <p className="text-xs text-rose-700">{err}</p>}
      {last && (
        <div className="text-xs" dir="ltr">
          <b>{(Number(last.total) / 100).toFixed(2)} {last.currency}</b> · {last.noteCount} notes · {Object.entries(last.denominations).map(([d, n]) => `${Number(d) / 100}×${n}`).join("  ")}
          {last.suspectedCounterfeits > 0 && <span className="ms-2 font-bold text-rose-700">⚠ {last.suspectedCounterfeits} suspected counterfeit</span>}
        </div>
      )}
    </div>
  );
}

export function CashOpForm({ kind, devices, t }: { kind: "deposit" | "withdraw"; devices: { deviceId: string; label: string }[]; t: Record<string, string> }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      setBusy(true); setMsg(null);
      try {
        const r = (await callApi(`/api/staff/teller/${kind}`, "POST", { accountId: fd.get("account"), amount, narrative: fd.get("narrative") || undefined, countSessionId: session ?? undefined, idempotencyKey: key })) as { pendingApproval?: boolean; entry?: { entryNo: string } };
        setMsg({ ok: true, text: r.pendingApproval ? t.pending : `${t.done} ${r.entry?.entryNo ?? ""}` });
        setKey(crypto.randomUUID()); setSession(null); setAmount("");
        router.refresh();
      } catch (x) { setMsg({ ok: false, text: (x as Error).message }); } finally { setBusy(false); }
    }}>
      <label className="block text-xs">{t.account}<input name="account" required placeholder="EG.. / id" dir="ltr" className={input} /></label>
      <label className="block text-xs">{t.amount}<input value={amount} onChange={(e) => { setAmount(e.target.value); setSession(null); }} required inputMode="decimal" dir="ltr" className={input} /></label>
      <label className="block text-xs">{t.narrative}<input name="narrative" className={input} /></label>
      <CountPanel devices={devices} purpose={kind === "deposit" ? "DEPOSIT" : "WITHDRAWAL"} t={t} onCount={(c) => { setAmount((Number(c.total) / 100).toFixed(2)); setSession(c.id); }} />
      {session && <p className="text-xs text-emerald-700">{t.bound}</p>}
      <div className="flex items-center gap-3"><button disabled={busy} className={btnCls}>{busy ? "…" : t.submit}</button>{msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</span>}</div>
    </form>
  );
}

export function BalanceTillForm({ tillId, devices, t }: { tillId: string; devices: { deviceId: string; label: string }[]; t: Record<string, string> }) {
  const router = useRouter();
  const [counted, setCounted] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (!window.confirm(t.confirmClose)) return;
      setBusy(true); setMsg(null);
      try {
        const r = (await callApi("/api/staff/tills", "POST", { action: "BALANCE", tillId, ...(session ? { countSessionId: session } : { counted }) })) as { variance: string };
        setMsg({ ok: true, text: `${t.variance}: ${(Number(r.variance) / 100).toFixed(2)}` });
        router.refresh();
      } catch (x) { setMsg({ ok: false, text: (x as Error).message }); } finally { setBusy(false); }
    }}>
      <CountPanel devices={devices} purpose="TILL_BALANCING" tillId={tillId} t={t} onCount={(c) => { setCounted((Number(c.total) / 100).toFixed(2)); setSession(c.id); }} />
      <div className="flex items-end gap-2">
        <label className="text-xs">{t.counted}<input value={counted} onChange={(e) => { setCounted(e.target.value); setSession(null); }} required dir="ltr" className={input} /></label>
        <button disabled={busy} className={btnCls}>{busy ? "…" : t.balance}</button>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</p>}
    </form>
  );
}
