"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnCls, callApi } from "./client";

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none";

export function StaffLoginForm({ t }: { t: Record<string, string> }) {
  const router = useRouter();
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      setBusy(true); setErr(null);
      try {
        await callApi("/api/staff/auth/login", "POST", { username: fd.get("username"), password: fd.get("password"), ...(fd.get("totp") ? { totp: fd.get("totp") } : {}) });
        router.push("/staff"); router.refresh();
      } catch (x) {
        const m = (x as Error).message;
        if (m.includes("TOTP_REQUIRED")) setNeedTotp(true);
        setErr(m);
      } finally { setBusy(false); }
    }}>
      <label className="block text-sm">{t.username}<input name="username" required autoComplete="username" dir="ltr" className={input} /></label>
      <label className="block text-sm">{t.password}<input name="password" type="password" required autoComplete="current-password" dir="ltr" className={input} /></label>
      {needTotp && <label className="block text-sm">{t.totp}<input name="totp" inputMode="numeric" maxLength={6} dir="ltr" className={input} autoFocus /></label>}
      {err && <p className="text-sm text-rose-700">{err}</p>}
      <button disabled={busy} className={`${btnCls} w-full py-2`}>{busy ? "…" : t.login}</button>
    </form>
  );
}

export function PortalLoginForm({ t }: { t: Record<string, string> }) {
  const router = useRouter();
  const [ch, setCh] = useState<{ challengeId: string; phoneHint: string; devCode?: string; username: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ch) {
    return (
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true); setErr(null);
        try {
          const r = (await callApi("/api/portal/auth/login", "POST", { username: fd.get("username"), password: fd.get("password") })) as { challengeId: string; phoneHint: string; devCode?: string };
          setCh({ ...r, username: String(fd.get("username")) });
        } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <label className="block text-sm">{t.username}<input name="username" required autoComplete="username" dir="ltr" className={input} /></label>
        <label className="block text-sm">{t.password}<input name="password" type="password" required autoComplete="current-password" dir="ltr" className={input} /></label>
        {err && <p className="text-sm text-rose-700">{err}</p>}
        <button disabled={busy} className={`${btnCls} w-full py-2`}>{busy ? "…" : t.next}</button>
      </form>
    );
  }
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const code = String(new FormData(e.currentTarget).get("code"));
      setBusy(true); setErr(null);
      try {
        await callApi("/api/portal/auth/verify", "POST", { username: ch.username, challengeId: ch.challengeId, code });
        router.push("/portal"); router.refresh();
      } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="text-sm text-slate-600">{t.otpSent} <span dir="ltr">{ch.phoneHint}</span></p>
      {ch.devCode && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">DEMO OTP: <b dir="ltr">{ch.devCode}</b></p>}
      <label className="block text-sm">{t.code}<input name="code" required inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" dir="ltr" className={`${input} tracking-widest`} autoFocus /></label>
      {err && <p className="text-sm text-rose-700">{err}</p>}
      <button disabled={busy} className={`${btnCls} w-full py-2`}>{busy ? "…" : t.login}</button>
    </form>
  );
}

export function OnboardingForm({ t, branches }: { t: Record<string, string>; branches: { code: string; name: string }[] }) {
  const router = useRouter();
  const [ch, setCh] = useState<{ challengeId: string; devCode?: string; phone: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (done) return <p className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">{done}</p>;
  if (!ch) {
    return (
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const body = Object.fromEntries(fd.entries());
        setBusy(true); setErr(null);
        try {
          const r = (await callApi("/api/portal/onboarding/start", "POST", body)) as { challengeId: string; devCode?: string };
          setCh({ ...r, phone: String(body.phone) });
        } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <label className="text-sm">{t.nameAr}<input name="nameAr" required className={input} /></label>
        <label className="text-sm">{t.nameEn}<input name="nameEn" required dir="ltr" className={input} /></label>
        <label className="text-sm">{t.nationalId}<input name="nationalId" required pattern="\d{14}" maxLength={14} dir="ltr" className={input} /></label>
        <label className="text-sm">{t.phone}<input name="phone" required placeholder="+2010xxxxxxxx" dir="ltr" className={input} /></label>
        <label className="text-sm">{t.email}<input name="email" type="email" dir="ltr" className={input} /></label>
        <label className="text-sm">{t.dob}<input name="dateOfBirth" type="date" required className={input} /></label>
        <label className="text-sm sm:col-span-2">{t.address}<input name="address" required className={input} /></label>
        <label className="text-sm">{t.branch}<select name="branchCode" className={input}>{branches.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select></label>
        <label className="text-sm">{t.currency}<select name="currency" className={input}>{["EGP", "USD", "EUR", "SAR"].map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="text-sm">{t.username}<input name="username" required pattern="[a-z0-9._\-]{4,32}" dir="ltr" className={input} /></label>
        <label className="text-sm sm:col-span-2">{t.password}<input name="password" type="password" required dir="ltr" className={input} /><span className="text-xs text-slate-500">{t.pwHint}</span></label>
        {err && <p className="text-sm text-rose-700 sm:col-span-2">{err}</p>}
        <button disabled={busy} className={`${btnCls} sm:col-span-2`}>{busy ? "…" : t.next}</button>
      </form>
    );
  }
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const code = String(new FormData(e.currentTarget).get("code"));
      setBusy(true); setErr(null);
      try {
        await callApi("/api/portal/onboarding/verify", "POST", { phone: ch.phone, challengeId: ch.challengeId, code });
        setDone(t.onboarded);
        setTimeout(() => router.push("/portal/login"), 2500);
      } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <p className="text-sm">{t.otpSent} <span dir="ltr">{ch.phone}</span></p>
      {ch.devCode && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">DEMO OTP: <b dir="ltr">{ch.devCode}</b></p>}
      <input name="code" required inputMode="numeric" pattern="\d{6}" maxLength={6} dir="ltr" className={`${input} max-w-40 tracking-widest`} />
      {err && <p className="text-sm text-rose-700">{err}</p>}
      <button disabled={busy} className={btnCls}>{busy ? "…" : t.confirm}</button>
    </form>
  );
}
