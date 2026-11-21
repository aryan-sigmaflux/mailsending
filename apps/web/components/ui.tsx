"use client";

import { LoaderCircle, Mail, Server, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { VerifyStatus } from "@/lib/types";

export function Modal({ open, onClose, title, sub, children, wide, footer }: {
  open: boolean; onClose: () => void; title: string; sub?: string; children: ReactNode; wide?: boolean; footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2>{title}</h2>
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          <button className="btn btn-icon btn-dark" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 mt-6">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle className="spin" width={size} height={size} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <b>{title}</b>
      {children && <div className="text-[13px] max-w-md mx-auto">{children}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ h = 18, w = "100%", className = "" }: { h?: number; w?: number | string; className?: string }) {
  return <div className={`skeleton ${className}`} style={{ height: h, width: w }} />;
}

const VERIFY: Record<VerifyStatus, [string, string]> = {
  valid: ["b-green", "Valid"],
  invalid: ["b-red", "Invalid"],
  catch_all: ["b-amber", "Catch-all"],
  risky: ["b-amber", "Risky"],
  unknown: ["b-gray", "Unverified"],
};

export function VerifyBadge({ status }: { status: VerifyStatus }) {
  const [cls, label] = VERIFY[status] ?? VERIFY.unknown;
  return <span className={`badge ${cls}`}>{label}</span>;
}

const STATUS: Record<string, string> = {
  running: "b-green", active: "b-green", completed: "b-blue", done: "b-blue", draft: "b-gray", paused: "b-amber",
  waiting: "b-pink", pending: "b-gray", error: "b-red", failed: "b-red", bounced: "b-red", replied: "b-green",
  unsubscribed: "b-amber", stopped: "b-gray", suspended: "b-red", pass: "b-green", warn: "b-amber", fail: "b-red",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${STATUS[status] ?? "b-gray"}`}>{label ?? status.replace("_", " ")}</span>;
}

export function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "google") return <span className="prov google" title="Google Workspace">G</span>;
  if (provider === "microsoft")
    return (
      <span className="prov microsoft" title="Microsoft 365">
        <svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6.3" height="6.3" rx="1" /><rect x="8.7" y="1" width="6.3" height="6.3" rx="1" /><rect x="1" y="8.7" width="6.3" height="6.3" rx="1" /><rect x="8.7" y="8.7" width="6.3" height="6.3" rx="1" /></svg>
      </span>
    );
  if (provider === "smtp") return <span className="prov smtp" title="SMTP / IMAP"><Server /></span>;
  return <span className="prov smtp"><Mail /></span>;
}

export function Meter({ value, max, tone = "pink" }: { value: number; max: number; tone?: "pink" | "green" | "amber" | "red" }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0;
  const color = { pink: "var(--grad-btn)", green: "var(--green)", amber: "var(--amber)", red: "var(--red)" }[tone];
  return (
    <div style={{ height: 6, borderRadius: 99, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
      <div style={{ width: `${p}%`, height: "100%", background: color, borderRadius: 99, transition: "width .6s var(--ease)" }} />
    </div>
  );
}

export function PageHeader({ title, accent, sub, actions }: { title: string; accent?: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="head in">
      <div>
        <h1>{title}{accent && <> <span className="accent">{accent}</span></>}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={`chip ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function confirmAction(message: string) {
  return typeof window !== "undefined" && window.confirm(message);
}
