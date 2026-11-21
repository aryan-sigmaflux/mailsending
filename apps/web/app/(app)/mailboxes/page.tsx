"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pause, Play, Plus, RefreshCw, Send, Settings, Trash } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, Modal, PageHeader, ProviderBadge, Seg, Skeleton, Spinner, StatusBadge, Toggle, confirmAction } from "@/components/ui";
import { del, get, patch, post } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Mailbox } from "@/lib/types";

const PRESETS: Record<string, { smtp_host: string; smtp_port: number; smtp_security: string; imap_host: string; imap_port: number }> = {
  custom: { smtp_host: "", smtp_port: 465, smtp_security: "ssl", imap_host: "", imap_port: 993 },
  gmail: { smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_security: "ssl", imap_host: "imap.gmail.com", imap_port: 993 },
  outlook: { smtp_host: "smtp.office365.com", smtp_port: 587, smtp_security: "starttls", imap_host: "outlook.office365.com", imap_port: 993 },
  zoho: { smtp_host: "smtp.zoho.com", smtp_port: 465, smtp_security: "ssl", imap_host: "imap.zoho.com", imap_port: 993 },
  yandex: { smtp_host: "smtp.yandex.com", smtp_port: 465, smtp_security: "ssl", imap_host: "imap.yandex.com", imap_port: 993 },
};

function ConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"google" | "microsoft" | "smtp">("google");
  const [preset, setPreset] = useState("custom");
  const [f, setF] = useState({ email: "", from_name: "", smtp_username: "", smtp_password: "", imap_password: "", daily_limit: 40, ...PRESETS.custom });
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => get<Record<string, boolean>>("/mailboxes/providers"), enabled: open });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  const oauth = useMutation({
    mutationFn: (p: string) => get<{ url: string }>(`/mailboxes/oauth/${p}/start`),
    onSuccess: (d) => (location.href = d.url),
    onError: toast.err,
  });
  const smtp = useMutation({
    mutationFn: () => post<Mailbox>("/mailboxes/smtp", { ...f, smtp_username: f.smtp_username || f.email, imap_password: f.imap_password || undefined, imap_host: f.imap_host || null, test: true }),
    onSuccess: (m) => {
      toast.ok(`Connected ${m.email}`);
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      onClose();
    },
    onError: toast.err,
  });

  return (
    <Modal open={open} onClose={onClose} title="Connect a mailbox" sub="Mailboxes are used to send campaigns and join the warmup pool." wide>
      <Seg value={tab} onChange={setTab} options={[{ value: "google", label: "Google Workspace" }, { value: "microsoft", label: "Microsoft 365" }, { value: "smtp", label: "SMTP / IMAP" }]} />
      {tab !== "smtp" ? (
        <div className="tile mt-5 text-center" style={{ padding: 30 }}>
          <div className="flex justify-center mb-3"><ProviderBadge provider={tab} /></div>
          <p className="text-[13.5px] text-txt-2 max-w-md mx-auto">
            You&apos;ll be redirected to {tab === "google" ? "Google" : "Microsoft"} to approve access. We use it to send email (SMTP) and detect replies (IMAP) — tokens are encrypted at rest.
          </p>
          {providers.data && !providers.data[tab] ? (
            <p className="badge b-amber mt-4" style={{ whiteSpace: "normal", padding: "8px 12px" }}>
              {tab === "google" ? "GOOGLE_CLIENT_ID / SECRET" : "MICROSOFT_CLIENT_ID / SECRET"} aren&apos;t set on the server yet. Use SMTP with an app password meanwhile.
            </p>
          ) : (
            <button className="btn btn-primary mt-5" disabled={oauth.isPending} onClick={() => oauth.mutate(tab)}>
              {oauth.isPending ? <Spinner /> : <>Continue with {tab === "google" ? "Google" : "Microsoft"}</>}
            </button>
          )}
        </div>
      ) : (
        <form className="mt-5 grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }} onSubmit={(e) => { e.preventDefault(); smtp.mutate(); }}>
          <Field label="Provider preset" className="col-span-2">
            <select className="select" value={preset} onChange={(e) => { setPreset(e.target.value); setF((s) => ({ ...s, ...PRESETS[e.target.value] })); }}>
              <option value="custom">Custom server</option>
              <option value="gmail">Gmail (app password)</option>
              <option value="outlook">Outlook / Office 365</option>
              <option value="zoho">Zoho Mail</option>
              <option value="yandex">Yandex</option>
            </select>
          </Field>
          <Field label="Email address"><input className="input" type="email" required value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Sender name"><input className="input" value={f.from_name} onChange={(e) => set("from_name", e.target.value)} placeholder="Aarav from Sigmaflux" /></Field>
          <Field label="SMTP host"><input className="input" required value={f.smtp_host} onChange={(e) => set("smtp_host", e.target.value)} /></Field>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Port"><input className="input" type="number" value={f.smtp_port} onChange={(e) => set("smtp_port", +e.target.value)} /></Field>
            <Field label="Security">
              <select className="select" value={f.smtp_security} onChange={(e) => set("smtp_security", e.target.value)}>
                <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">None</option>
              </select>
            </Field>
          </div>
          <Field label="SMTP username" hint="Defaults to the email address"><input className="input" value={f.smtp_username} onChange={(e) => set("smtp_username", e.target.value)} /></Field>
          <Field label="Password / app password"><input className="input" type="password" required value={f.smtp_password} onChange={(e) => set("smtp_password", e.target.value)} /></Field>
          <Field label="IMAP host" hint="Needed for reply detection & warmup"><input className="input" value={f.imap_host} onChange={(e) => set("imap_host", e.target.value)} /></Field>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="IMAP port"><input className="input" type="number" value={f.imap_port} onChange={(e) => set("imap_port", +e.target.value)} /></Field>
            <Field label="Daily limit"><input className="input" type="number" min={1} value={f.daily_limit} onChange={(e) => set("daily_limit", +e.target.value)} /></Field>
          </div>
          <div className="col-span-2 flex justify-end gap-2 mt-2">
            <button type="button" className="btn btn-dark" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={smtp.isPending}>{smtp.isPending ? <><Spinner /> Testing connection…</> : "Test & connect"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function SettingsModal({ mb, onClose }: { mb: Mailbox; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Partial<Mailbox>>(() => ({ from_name: mb.from_name, signature_html: mb.signature_html, daily_limit: mb.daily_limit, min_delay_seconds: mb.min_delay_seconds, max_delay_seconds: mb.max_delay_seconds }));
  const save = useMutation({
    mutationFn: () => patch<Mailbox>(`/mailboxes/${mb.id}`, f),
    onSuccess: () => { toast.ok("Mailbox saved"); qc.invalidateQueries({ queryKey: ["mailboxes"] }); onClose(); },
    onError: toast.err,
  });
  const [to, setTo] = useState("");
  const test = useMutation({ mutationFn: () => post(`/mailboxes/${mb.id}/send-test`, { to }), onSuccess: () => toast.ok(`Test email sent to ${to}`), onError: toast.err });
  return (
    <Modal open onClose={onClose} title={mb.email} sub="Sending settings" footer={<><button className="btn btn-dark" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</button></>}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Field label="Sender name" className="col-span-2"><input className="input" value={f.from_name ?? ""} onChange={(e) => setF({ ...f, from_name: e.target.value })} /></Field>
        <Field label="Daily sending limit" hint="Recommended: 30–50 for cold email"><input className="input" type="number" value={f.daily_limit ?? 0} onChange={(e) => setF({ ...f, daily_limit: +e.target.value })} /></Field>
        <div />
        <Field label="Min delay between emails (s)"><input className="input" type="number" value={f.min_delay_seconds ?? 0} onChange={(e) => setF({ ...f, min_delay_seconds: +e.target.value })} /></Field>
        <Field label="Max delay (s)"><input className="input" type="number" value={f.max_delay_seconds ?? 0} onChange={(e) => setF({ ...f, max_delay_seconds: +e.target.value })} /></Field>
        <Field label="Signature (HTML)" className="col-span-2"><textarea className="textarea" value={f.signature_html ?? ""} onChange={(e) => setF({ ...f, signature_html: e.target.value })} placeholder="<p>— Aarav<br/>Sigmaflux</p>" /></Field>
      </div>
      <div className="tile mt-5 flex gap-2 items-end">
        <Field label="Send a test email to" className="flex-1"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@company.com" /></Field>
        <button className="btn btn-ghost" disabled={!to || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Spinner /> : <><Send /> Send</>}</button>
      </div>
    </Modal>
  );
}

export default function MailboxesPage() {
  const qc = useQueryClient();
  const [connect, setConnect] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const q = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    if (sp.get("connected")) toast.ok(`Connected ${sp.get("connected")}`);
    if (sp.get("error")) toast.err(`Connection failed: ${sp.get("error")}`);
    if (sp.size) history.replaceState(null, "", "/mailboxes");
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: ["mailboxes"] });
  const testMb = useMutation({
    mutationFn: (id: string) => post<{ ok: boolean; smtp: string; imap: string | null }>(`/mailboxes/${id}/test`),
    onSuccess: (r) => { r.ok ? toast.ok("Connection healthy") : toast.err(`SMTP: ${r.smtp} · IMAP: ${r.imap ?? "n/a"}`); refresh(); },
    onError: toast.err,
  });
  const toggle = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<Mailbox> }) => patch(`/mailboxes/${id}`, body), onSuccess: refresh, onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/mailboxes/${id}`), onSuccess: () => { toast.ok("Mailbox removed"); refresh(); }, onError: toast.err });

  const list = q.data ?? [];
  const capacity = list.filter((m) => m.status === "active").reduce((a, m) => a + m.daily_limit, 0);

  return (
    <>
      <PageHeader title="Mailboxes" sub={list.length ? `${list.length} connected · ${capacity} emails/day capacity` : "Connect the inboxes you send from"}
        actions={<button className="btn btn-primary" onClick={() => setConnect(true)}><Plus /> Connect mailbox</button>} />
      <article className="card in" style={{ padding: 6 }}>
        {q.isLoading ? (
          <div className="p-4 flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>
        ) : !list.length ? (
          <Empty icon={<Mail />} title="No mailboxes yet" action={<button className="btn btn-primary" onClick={() => setConnect(true)}><Plus /> Connect your first mailbox</button>}>
            Connect Google Workspace, Microsoft 365 or any SMTP/IMAP inbox.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Mailbox</th><th>Status</th><th style={{ width: 200 }}>Sent today</th><th>Warmup</th><th>Last sent</th><th /></tr></thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <ProviderBadge provider={m.provider} />
                        <div className="min-w-0">
                          <div className="truncate-1">{m.email}</div>
                          <div className="text-[11.5px] text-muted truncate-1">{m.from_name || "No sender name"}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={m.status} />
                      {m.last_error && <div className="text-[11px] text-red mt-1 max-w-[220px] truncate-1" title={m.last_error}>{m.last_error}</div>}
                    </td>
                    <td>
                      <div className="text-[12px] mb-1.5">{m.sent_today} / {m.daily_limit}</div>
                      <Meter value={m.sent_today} max={m.daily_limit} tone={m.sent_today >= m.daily_limit ? "amber" : "pink"} />
                    </td>
                    <td><Toggle on={m.warmup_enabled} label="Warmup" onChange={(v) => toggle.mutate({ id: m.id, body: { warmup_enabled: v } })} /></td>
                    <td className="text-txt-2 text-[12.5px]">{ago(m.last_sent_at)}</td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <button className="btn btn-icon btn-sm btn-dark" title="Test connection" onClick={() => testMb.mutate(m.id)} disabled={testMb.isPending && testMb.variables === m.id}>
                          {testMb.isPending && testMb.variables === m.id ? <Spinner size={14} /> : <RefreshCw />}
                        </button>
                        <button className="btn btn-icon btn-sm btn-dark" title={m.status === "paused" ? "Resume" : "Pause"} onClick={() => toggle.mutate({ id: m.id, body: { status: m.status === "paused" ? "active" : "paused" } })}>
                          {m.status === "paused" ? <Play /> : <Pause />}
                        </button>
                        <button className="btn btn-icon btn-sm btn-dark" title="Settings" onClick={() => setEditing(m)}><Settings /></button>
                        <button className="btn btn-icon btn-sm btn-danger" title="Remove" onClick={() => confirmAction(`Remove ${m.email}? Campaigns using it will stop sending from it.`) && remove.mutate(m.id)}><Trash /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
      <ConnectModal open={connect} onClose={() => setConnect(false)} />
      {editing && <SettingsModal key={editing.id} mb={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
