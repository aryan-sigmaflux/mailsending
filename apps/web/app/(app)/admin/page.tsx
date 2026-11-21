"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash, Users } from "lucide-react";
import { useState } from "react";
import { PerfChart } from "@/components/PerfChart";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, Modal, PageHeader, ProviderBadge, Seg, Skeleton, Spinner, StatusBadge, Toggle, confirmAction } from "@/components/ui";
import { del, get, patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ago, num } from "@/lib/format";
import type { Features, Usage, User } from "@/lib/types";

interface Row { user: User; usage: Usage }
interface Stats { users: number; active_users: number; mailboxes: number; domains: number; running_campaigns: number; emails_today: number; emails_total: number; series: { day: string; sent: number }[] }
interface PoolRow { id: string; email: string; owner: string; provider: string; status: string; health_score: number }

const LIMITS: [keyof User, string][] = [
  ["max_daily_emails", "Emails / day"], ["max_monthly_emails", "Emails / month"], ["max_domains", "Domains"], ["max_mailboxes", "Mailboxes"],
  ["max_campaigns", "Active campaigns"], ["max_contacts", "Contacts"], ["verify_credits_monthly", "Verification credits / month"],
];
const FEATURES: [keyof Features, string][] = [["sequences", "Sequences"], ["warmup", "Warmup"], ["apollo", "Apollo lead finder"], ["ai", "AI (own keys)"], ["tracking_domain", "Custom tracking domain"]];
const DEFAULTS = { max_daily_emails: 500, max_monthly_emails: 10000, max_domains: 3, max_mailboxes: 10, max_campaigns: 10, max_contacts: 10000, verify_credits_monthly: 1000 };

function UserModal({ row, open, onClose }: { row: Row | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = !row;
  const [f, setF] = useState<Record<string, unknown>>(() =>
    row ? { ...row.user, expires_at: row.user.expires_at?.slice(0, 10) ?? "" } : { email: "", password: "", full_name: "", role: "user", expires_at: "", features: { sequences: true, warmup: true, apollo: true, ai: true, tracking_domain: true }, ...DEFAULTS });
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const limits = Object.fromEntries(LIMITS.map(([k]) => [k, Number(f[k])]));
      const expires = f.expires_at ? new Date(`${f.expires_at}T23:59:59`).toISOString() : null;
      return isNew
        ? post("/admin/users", { email: f.email, password: f.password, full_name: f.full_name, role: f.role, features: f.features, expires_at: expires, ...limits })
        : patch(`/admin/users/${row!.user.id}`, { full_name: f.full_name, role: f.role, features: f.features, ...limits, ...(expires ? { expires_at: expires } : { clear_expiry: true }) });
    },
    onSuccess: () => { toast.ok(isNew ? "User created" : "User updated"); qc.invalidateQueries({ queryKey: ["admin-users"] }); qc.invalidateQueries({ queryKey: ["admin-stats"] }); onClose(); },
    onError: toast.err,
  });
  const feats = (f.features ?? {}) as Features;
  return (
    <Modal open={open} onClose={onClose} wide title={isNew ? "Create user" : `Edit ${row?.user.email}`} sub="Each user is a separate workspace with its own limits."
      footer={<><button className="btn btn-dark" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : isNew ? "Create user" : "Save changes"}</button></>}>
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {isNew && <Field label="Email"><input className="input" type="email" value={(f.email as string) ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>}
        {isNew && <Field label="Initial password" hint="Min 8 characters — share it securely"><input className="input" type="text" value={(f.password as string) ?? ""} onChange={(e) => set("password", e.target.value)} /></Field>}
        <Field label="Full name"><input className="input" value={(f.full_name as string) ?? ""} onChange={(e) => set("full_name", e.target.value)} /></Field>
        <Field label="Role"><select className="select" value={(f.role as string) ?? "user"} onChange={(e) => set("role", e.target.value)}><option value="user">User</option><option value="super_admin">Super admin</option></select></Field>
        <Field label="Account expires" hint="Leave empty for no expiry"><input className="input" type="date" value={(f.expires_at as string) ?? ""} onChange={(e) => set("expires_at", e.target.value)} /></Field>
      </div>
      <div className="nav-label" style={{ padding: "22px 0 10px" }}>Limits</div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {LIMITS.map(([k, l]) => <Field key={k} label={l}><input className="input" type="number" min={0} value={(f[k] as number) ?? 0} onChange={(e) => set(k, e.target.value)} /></Field>)}
      </div>
      <div className="nav-label" style={{ padding: "22px 0 10px" }}>Features</div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {FEATURES.map(([k, l]) => <label key={k} className="tile flex items-center justify-between" style={{ padding: "10px 14px" }}><span className="text-[13.5px]">{l}</span><Toggle on={!!feats[k]} onChange={(v) => set("features", { ...feats, [k]: v })} label={l} /></label>)}
      </div>
    </Modal>
  );
}

export default function AdminPage() {
  const me = useAuth((s) => s.me);
  const qc = useQueryClient();
  const [tab, setTab] = useState<"users" | "pool">("users");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const isAdmin = me?.user.role === "super_admin";
  const stats = useQuery({ queryKey: ["admin-stats"], queryFn: () => get<Stats>("/admin/stats"), enabled: isAdmin });
  const users = useQuery({ queryKey: ["admin-users", q], queryFn: () => get<Row[]>(`/admin/users?q=${encodeURIComponent(q)}`), enabled: isAdmin });
  const pool = useQuery({ queryKey: ["admin-pool"], queryFn: () => get<PoolRow[]>("/admin/warmup-pool"), enabled: isAdmin && tab === "pool" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => patch(`/admin/users/${id}`, { status }), onSuccess: refresh, onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/admin/users/${id}`), onSuccess: () => { toast.ok("User deleted"); refresh(); }, onError: toast.err });
  const reset = useMutation({ mutationFn: ({ id, password }: { id: string; password: string }) => post(`/admin/users/${id}/password`, { password }), onSuccess: () => toast.ok("Password reset"), onError: toast.err });
  const unpool = useMutation({ mutationFn: (id: string) => post(`/admin/warmup-pool/${id}/remove`), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-pool"] }), onError: toast.err });

  if (!isAdmin) return <article className="card"><Empty icon={<ShieldCheck />} title="Admins only" /></article>;
  const s = stats.data;

  return (
    <>
      <PageHeader title="Admin" accent="panel" sub="Create users, set their sending limits and features, and manage the shared warmup pool"
        actions={<button className="btn btn-primary" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> Create user</button>} />
      <div className="grid gap-3 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {[["Users", s?.users, `${num(s?.active_users)} active`], ["Mailboxes", s?.mailboxes, ""], ["Domains", s?.domains, ""], ["Running campaigns", s?.running_campaigns, ""], ["Emails today", s?.emails_today, ""], ["Emails all-time", s?.emails_total, ""]].map(([l, v, sub], i) => (
          <article key={l as string} className={`card ${i === 0 ? "glow" : ""}`}><div className="text-[12.5px] text-txt-2">{l}</div><div className="text-[26px] font-medium mt-2">{s ? num(v as number) : "—"}</div>{sub && <div className="text-[12px] text-muted">{sub}</div>}</article>
        ))}
      </div>
      {s && (
        <article className="card in">
          <h3>Platform sending · last 14 days</h3>
          <div className="mt-3"><PerfChart points={s.series.map((d) => ({ t: d.day, sent: d.sent, opened: 0, replied: 0 }))} range="1M" height={200} /></div>
        </article>
      )}

      <article className="card in">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Seg value={tab} onChange={setTab} options={[{ value: "users", label: "Users" }, { value: "pool", label: "Warmup pool" }]} />
          {tab === "users" && <div className="ask" style={{ height: 38, width: 260 }}><Search /><input placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
        </div>
        {tab === "users" ? (
          users.isLoading ? <Skeleton h={200} className="mt-4" /> : !users.data?.length ? <Empty icon={<Users />} title="No users yet" /> : (
            <div className="overflow-x-auto mt-3">
              <table className="table">
                <thead><tr><th>User</th><th>Status</th><th style={{ width: 160 }}>Emails today</th><th>Mailboxes</th><th>Domains</th><th>Contacts</th><th>Last login</th><th /></tr></thead>
                <tbody>
                  {users.data.map((r) => {
                    const u = r.user;
                    const expired = u.expires_at && new Date(u.expires_at) < new Date();
                    return (
                      <tr key={u.id}>
                        <td><div className="flex items-center gap-2">{u.full_name || u.email}{u.role === "super_admin" && <span className="badge b-pink">admin</span>}</div><div className="text-[11.5px] text-muted">{u.email}</div></td>
                        <td><StatusBadge status={expired ? "failed" : u.status} label={expired ? "expired" : u.status} /></td>
                        <td><div className="text-[12px] mb-1">{num(r.usage.emails_today)} / {num(u.max_daily_emails)}</div><Meter value={r.usage.emails_today} max={u.max_daily_emails} /></td>
                        <td>{r.usage.mailboxes}<span className="text-muted">/{u.max_mailboxes}</span></td>
                        <td>{r.usage.domains}<span className="text-muted">/{u.max_domains}</span></td>
                        <td>{num(r.usage.contacts)}<span className="text-muted">/{num(u.max_contacts)}</span></td>
                        <td className="text-[12.5px] text-txt-2">{ago(u.last_login_at)}</td>
                        <td>
                          <div className="flex justify-end gap-1.5">
                            <button className="btn btn-icon btn-sm btn-dark" title="Edit limits" onClick={() => { setEditing(r); setOpen(true); }}><Pencil /></button>
                            <button className="btn btn-icon btn-sm btn-dark" title="Reset password" onClick={() => { const p = prompt(`New password for ${u.email} (min 8 chars)`); if (p) reset.mutate({ id: u.id, password: p }); }}><KeyRound /></button>
                            {u.id !== me!.user.id && (
                              <>
                                <button className={`btn btn-sm ${u.status === "active" ? "btn-ghost" : "btn-primary"}`} onClick={() => setStatus.mutate({ id: u.id, status: u.status === "active" ? "suspended" : "active" })}>{u.status === "active" ? "Suspend" : "Activate"}</button>
                                <button className="btn btn-icon btn-sm btn-danger" title="Delete user" onClick={() => confirmAction(`Delete ${u.email} and ALL their data? This cannot be undone.`) && remove.mutate(u.id)}><Trash /></button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : !pool.data?.length ? <Empty icon={<Flame />} title="Warmup pool is empty">Mailboxes join the shared pool when their owner turns warmup on.</Empty> : (
          <div className="overflow-x-auto mt-3">
            <table className="table">
              <thead><tr><th>Mailbox</th><th>Owner</th><th>Status</th><th>Health</th><th /></tr></thead>
              <tbody>{pool.data.map((m) => (
                <tr key={m.id}><td><div className="flex items-center gap-2"><ProviderBadge provider={m.provider} />{m.email}</div></td><td className="text-txt-2">{m.owner}</td><td><StatusBadge status={m.status} /></td><td>{m.health_score}</td>
                  <td className="text-right"><button className="btn btn-sm btn-danger" onClick={() => confirmAction(`Remove ${m.email} from the warmup pool?`) && unpool.mutate(m.id)}>Remove from pool</button></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </article>
      {open && <UserModal key={editing?.user.id ?? "new"} row={editing} open onClose={() => setOpen(false)} />}
    </>
  );
}
