"use client";

import { ArrowUpRight, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await login(email, password);
      router.replace(user.role === "super_admin" ? "/admin" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  }

  return (
    <div className="shell" style={{ gridTemplateColumns: "1fr", placeItems: "center" }}>
      <div className="card in" style={{ width: "min(440px, 100%)", padding: "38px 34px 30px" }}>
        <div className="arc" style={{ bottom: -300, opacity: 0.55 }} />
        <div className="relative">
          <div className="brand" style={{ padding: 0, marginBottom: 30 }}>
            <Mail width={24} height={24} strokeWidth={2.4} />
            <b>Sigmaflux Mail</b>
          </div>
          <h1 style={{ margin: 0, fontWeight: 400, fontSize: 26 }}>Welcome back</h1>
          <p className="card-sub" style={{ fontSize: 13.5, marginTop: 6 }}>Sign in to your outreach workspace.</p>
          <form onSubmit={submit} className="flex flex-col gap-4 mt-7">
            <label className="field">
              <span>Email</span>
              <input className="input" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error && <div className="badge b-red" style={{ padding: "8px 12px", fontSize: 12.5, whiteSpace: "normal" }}>{error}</div>}
            <button className="btn btn-primary mt-2" disabled={busy} style={{ height: 44 }}>
              {busy ? <Spinner /> : <>Sign in <ArrowUpRight /></>}
            </button>
          </form>
          <p className="card-sub text-center" style={{ marginTop: 22 }}>Accounts are created by your administrator.</p>
        </div>
      </div>
    </div>
  );
}
