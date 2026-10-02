"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnCls, callApi } from "./client";

const input = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";
const RC: Record<string, string> = { "00": "Approved", "05": "Do not honour", "13": "Invalid amount", "14": "Invalid card", "51": "Insufficient funds", "54": "Expired", "55": "Incorrect PIN", "57": "Not permitted", "61": "Limit exceeded", "62": "Restricted card", "65": "PIN required (contactless)", "68": "Timeout → auto-reversed", "75": "PIN tries exceeded", "91": "Issuer/ATM unavailable", "1A": "3-D Secure required", "25": "Original not found" };

type Opt = { value: string; label: string };
type IsoRes = { mti: string; fields: Record<string, string>; reversal?: string };

/** Staff-side POS / e-commerce / contactless acquirer simulator (with 3-D Secure step-up). */
export function PosSimulatorForm({ cards, t }: { cards: Opt[]; t: Record<string, string> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ challengeId: string; stan: string; body: Record<string, unknown>; devCode?: string } | null>(null);
  async function send(body: Record<string, unknown>) {
    const r = (await callApi("/api/staff/cards/simulate", "POST", body)) as IsoRes;
    const rc = r.fields["39"];
    const extra = r.fields["48"] ? JSON.parse(r.fields["48"]) : {};
    if (rc === "1A") setChallenge({ challengeId: extra.challengeId, stan: r.fields["11"], body, devCode: extra.devCode });
    else setChallenge(null);
    setOut(`${rc} ${RC[rc] ?? ""} · RRN ${r.fields["37"] ?? "—"}${r.fields["38"] ? ` · auth ${r.fields["38"]}` : ""}`);
    router.refresh();
  }
  return (
    <div className="space-y-3">
      <form className="grid grid-cols-2 gap-2 md:grid-cols-4" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true); setOut(null);
        try {
          await send({ cardId: fd.get("cardId"), mode: fd.get("mode"), amount: fd.get("amount"), pin: fd.get("pin") || undefined, merchantName: fd.get("merchantName"), mcc: fd.get("mcc"), country: fd.get("country") });
        } catch (x) { setOut((x as Error).message); } finally { setBusy(false); }
      }}>
        <label className="col-span-2 text-xs">{t.card}<select name="cardId" className={input}>{cards.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
        <label className="text-xs">{t.mode}<select name="mode" className={input}><option value="CHIP">POS (chip + PIN)</option><option value="CONTACTLESS">Contactless</option><option value="ECOM">E-commerce (3-D Secure)</option></select></label>
        <label className="text-xs">{t.amount}<input name="amount" required defaultValue="250.00" dir="ltr" className={input} /></label>
        <label className="text-xs">{t.merchant}<input name="merchantName" defaultValue="Carrefour Maadi" className={input} /></label>
        <label className="text-xs">MCC<input name="mcc" defaultValue="5411" dir="ltr" className={input} /></label>
        <label className="text-xs">{t.country}<input name="country" defaultValue="EG" maxLength={2} dir="ltr" className={input} /></label>
        <label className="text-xs">PIN<input name="pin" type="password" inputMode="numeric" maxLength={6} dir="ltr" className={input} /></label>
        <div className="col-span-2 md:col-span-4"><button disabled={busy} className={btnCls}>{busy ? "…" : t.send}</button></div>
      </form>
      {challenge && (
        <form className="flex flex-wrap items-end gap-2 rounded border border-amber-300 bg-amber-50 p-2" onSubmit={async (e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get("code"));
          setBusy(true);
          try { await send({ ...challenge.body, stan: challenge.stan, threeDs: { challengeId: challenge.challengeId, code } }); } catch (x) { setOut((x as Error).message); } finally { setBusy(false); }
        }}>
          <span className="text-xs text-amber-900">{t.threeDs}{challenge.devCode && <> — DEMO OTP <b dir="ltr">{challenge.devCode}</b></>}</span>
          <input name="code" required maxLength={6} dir="ltr" className={`${input} w-28`} />
          <button className={btnCls}>{t.verify}</button>
        </form>
      )}
      {out && <p className="text-sm font-medium" dir="ltr">{out}</p>}
    </div>
  );
}

/** Built-in ATM simulator: talks ISO 8583 to the issuer host through the switch adapter. */
export function AtmSimulatorForm({ atms, cards, t }: { atms: Opt[]; cards: Opt[]; t: Record<string, string> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  return (
    <form className="grid grid-cols-2 gap-2 md:grid-cols-3" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      setBusy(true); setOut(null);
      try {
        const r = (await callApi("/api/staff/atms/simulate", "POST", { terminalId: fd.get("terminalId"), cardId: fd.get("cardId"), pin: fd.get("pin"), op: fd.get("op"), amount: fd.get("amount") || undefined })) as IsoRes;
        const rc = r.fields["39"];
        const extra = r.fields["48"] ? JSON.parse(r.fields["48"]) : {};
        const bal = r.fields["54"] ? ` · balance ${(Number(r.fields["54"].slice(-12)) / 100).toFixed(2)}` : "";
        const notes = extra.dispensed ? ` · notes ${extra.dispensed.map((d: { den: string; n: number }) => `${Number(d.den) / 100}×${d.n}`).join(" ")}` : "";
        const mini = extra.miniStatement ? `\n${extra.miniStatement.map((m: { d: string; t: string; dr: string; cr: string }) => `${m.d} ${m.t.slice(0, 24).padEnd(24)} ${m.dr !== "0" ? "-" + (Number(m.dr) / 100).toFixed(2) : "+" + (Number(m.cr) / 100).toFixed(2)}`).join("\n")}` : "";
        setOut(`${rc} ${RC[rc] ?? ""} · RRN ${r.fields["37"] ?? "—"}${bal}${notes}${r.reversal ? ` · reversal ${r.reversal}` : ""}${mini}`);
        router.refresh();
      } catch (x) { setOut((x as Error).message); } finally { setBusy(false); }
    }}>
      <label className="text-xs">{t.atm}<select name="terminalId" className={input}>{atms.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</select></label>
      <label className="text-xs md:col-span-2">{t.card}<select name="cardId" className={input}>{cards.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      <label className="text-xs">{t.op}<select name="op" className={input}>
        <option value="WITHDRAW">{t.withdraw}</option><option value="BALANCE">{t.balance}</option><option value="MINI">{t.mini}</option>
        <option value="WITHDRAW_DISPENSE_FAULT">{t.fault}</option><option value="WITHDRAW_TIMEOUT">{t.timeout}</option></select></label>
      <label className="text-xs">{t.amount}<input name="amount" defaultValue="500" dir="ltr" className={input} /></label>
      <label className="text-xs">PIN<input name="pin" type="password" required inputMode="numeric" maxLength={6} dir="ltr" className={input} /></label>
      <div className="col-span-2 md:col-span-3"><button disabled={busy} className={btnCls}>{busy ? "…" : t.send}</button></div>
      {out && <pre className="col-span-2 whitespace-pre-wrap text-sm font-medium md:col-span-3" dir="ltr">{out}</pre>}
    </form>
  );
}

/** Portal: MOCK online-store checkout to try 3-D Secure end to end. */
export function DemoCheckout({ cardId, t }: { cardId: string; t: Record<string, string> }) {
  const router = useRouter();
  const [stage, setStage] = useState<{ stan: string; challengeId: string; amount: string; devCode?: string } | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newStan = () => String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return stage ? (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      const code = String(new FormData(e.currentTarget).get("code"));
      setBusy(true);
      try {
        const r = (await callApi(`/api/portal/cards/${cardId}/simulate`, "POST", { amount: stage.amount, stan: stage.stan, threeDs: { challengeId: stage.challengeId, code } })) as { responseCode: string };
        setOut(r.responseCode === "00" ? t.approved : `${t.declined} (${r.responseCode} ${RC[r.responseCode] ?? ""})`);
        setStage(null); router.refresh();
      } catch (x) { setOut((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="text-sm">{t.otp}</p>
      {stage.devCode && <p className="text-xs text-amber-800">DEMO OTP <b dir="ltr">{stage.devCode}</b></p>}
      <input name="code" required maxLength={6} dir="ltr" className={`${input} w-32 tracking-widest`} />
      <button disabled={busy} className={btnCls}>{t.verify}</button>
    </form>
  ) : (
    <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
      e.preventDefault();
      const amount = String(new FormData(e.currentTarget).get("amount"));
      const stan = newStan();
      setBusy(true); setOut(null);
      try {
        const r = (await callApi(`/api/portal/cards/${cardId}/simulate`, "POST", { amount, stan })) as { responseCode: string; challengeId?: string; devCode?: string };
        if (r.responseCode === "1A" && r.challengeId) setStage({ stan, challengeId: r.challengeId, amount, devCode: r.devCode });
        else setOut(r.responseCode === "00" ? t.approved : `${t.declined} (${r.responseCode} ${RC[r.responseCode] ?? ""})`);
        router.refresh();
      } catch (x) { setOut((x as Error).message); } finally { setBusy(false); }
    }}>
      <label className="text-xs">{t.amount}<input name="amount" defaultValue="199.00" dir="ltr" className={`${input} w-32`} /></label>
      <button disabled={busy} className={btnCls}>{t.pay}</button>
      {out && <span className="text-sm">{out}</span>}
    </form>
  );
}
