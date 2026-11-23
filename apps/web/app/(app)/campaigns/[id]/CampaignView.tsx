"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChartColumn, CircleCheck, CircleExclamationPoint, Eye, MousePointerClick, Pause, Play, Reply, Rocket, Save } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, Modal, ProviderBadge, Seg, Skeleton, Spinner, StatusBadge, Toggle } from "@/components/ui";
import { get, post, put } from "@/lib/api";
import { DAYS, TIMEZONES, ago, num, pct, until } from "@/lib/format";
import type { Campaign, ContactList, Mailbox, Paged, Sequence, Template } from "@/lib/types";

interface Preflight { errors: string[]; audience: number; variables: string[]; missing: { variable: string; leads: number }[]; leads_missing: number; capacity_today: number; mailbox_capacity_per_day: number }
interface CC { id: string; email: string; first_name: string; company: string; state: string; current_node: string | null; next_run_at: string | null; steps_sent: number; last_sent_at: string | null; error: string | null; opened_at: string | null; clicked_at: string | null; replied_at: string | null; opens: number; clicks: number }

const when = (iso: string) => new Date(iso).toLocaleString();

/** Opened / Clicked / Replied tags for one lead (only human engagement is counted by the API). */
function Engagement({ x }: { x: CC }) {
  if (!x.steps_sent && !x.last_sent_at) return <span className="text-muted text-[12px]">—</span>;
  if (!x.opened_at && !x.clicked_at && !x.replied_at) return <span className="badge b-gray">Not opened</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {x.opened_at && <span className="badge b-pink" title={`First opened ${when(x.opened_at)}${x.opens > 1 ? ` · ${x.opens} opens` : ""}`}><Eye /> Opened{x.opens > 1 ? ` ×${x.opens}` : ""}</span>}
      {x.clicked_at && <span className="badge b-blue" title={`First clicked ${when(x.clicked_at)}`}><MousePointerClick /> Clicked{x.clicks > 1 ? ` ×${x.clicks}` : ""}</span>}
      {x.replied_at && <span className="badge b-green" title={`Replied ${when(x.replied_at)}`}><Reply /> Replied</span>}
    </div>
  );
}
interface Step { node_id: string; template: string | null; sent: number; opened: number; clicked: number; replied: number }

function Picker<T extends { id: string }>({ items, value, onChange, render, empty }: { items: T[]; value: string[]; onChange: (v: string[]) => void; render: (t: T) => React.ReactNode; empty: React.ReactNode }) {
  if (!items.length) return <div className="tile text-[12.5px] text-muted">{empty}</div>;
  return (
    <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto pr-1">
      {items.map((t) => (
        <label key={t.id} className="check tile" style={{ padding: "9px 12px" }}>
          <input type="checkbox" checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} />
          <span className="min-w-0 flex-1">{render(t)}</span>
        </label>
      ))}
    </div>
  );
}

function Setup({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const [f, setF] = useState(c);
  const [dirty, setDirty] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [policy, setPolicy] = useState<"fallback" | "skip" | "block">("fallback");
  const set = (p: Partial<Campaign>) => { setF((s) => ({ ...s, ...p })); setDirty(true); };
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => get<ContactList[]>("/lists") });
  const mbs = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });
  const tpls = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/templates") });
  const seqs = useQuery({ queryKey: ["sequences"], queryFn: () => get<Sequence[]>("/sequences") });

  const body = () => ({ name: f.name, kind: f.kind, sequence_id: f.sequence_id, template_ids: f.template_ids, list_ids: f.list_ids, mailbox_ids: f.mailbox_ids, schedule: f.schedule, settings: f.settings });
  const save = useMutation({ mutationFn: () => put<Campaign>(`/campaigns/${c.id}`, body()), onSuccess: (x) => { setDirty(false); qc.setQueryData(["campaign", c.id], x); }, onError: toast.err });
  const preflight = useMutation({ mutationFn: async () => { if (dirty) await save.mutateAsync(); return post<Preflight>(`/campaigns/${c.id}/preflight`); }, onError: toast.err });
  const launch = useMutation({
    mutationFn: () => post<Campaign>(`/campaigns/${c.id}/launch`, { missing_policy: policy }),
    onSuccess: (x) => { toast.ok(`Launched to ${num(x.stats.contacts)} leads`); setLaunchOpen(false); qc.setQueryData(["campaign", c.id], x); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
    onError: toast.err,
  });
  useEffect(() => { preflight.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pf = preflight.data;
  const sch = f.schedule;

  return (
    <>
      <header className="head in">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link href="/campaigns" className="btn btn-icon btn-dark" aria-label="Back"><ArrowLeft /></Link>
          <input className="input" style={{ fontSize: 20, background: "transparent", boxShadow: "none", padding: "4px 6px" }} value={f.name} onChange={(e) => set({ name: e.target.value })} aria-label="Campaign name" />
          <StatusBadge status={c.status} />
        </div>
        <div className="flex gap-2">
          <button className="btn btn-dark" onClick={() => save.mutate()} disabled={!dirty || save.isPending}><Save /> {dirty ? "Save draft" : "Saved"}</button>
          <button className="btn btn-primary" onClick={async () => { await preflight.mutateAsync(); setLaunchOpen(true); }}><Rocket /> Review & launch</button>
        </div>
      </header>

      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(300px, 1fr)", ["--d" as string]: 1 }}>
        <div className="flex flex-col gap-4">
          <article className="card">
            <h3>1 · What to send</h3>
            <div className="mt-4"><Seg value={f.kind} onChange={(k) => set({ kind: k })} options={[{ value: "single", label: "Single template" }, { value: "sequence", label: "Sequence" }]} /></div>
            <div className="mt-4">
              {f.kind === "single" ? (
                <div className="field">
                  <span>Templates {f.template_ids.length > 1 && <small className="text-pink">— each lead gets one at random (even split)</small>}</span>
                  <Picker items={tpls.data ?? []} value={f.template_ids} onChange={(v) => set({ template_ids: v })} empty={<>No templates — <Link className="text-pink" href="/templates">create one</Link></>}
                    render={(t) => <><span className="block truncate-1">{t.name}</span><small className="text-muted block truncate-1">{t.subject || "⚠ no subject"}</small></>} />
                </div>
              ) : (
                <Field label="Sequence" hint={<Link className="text-pink" href={f.sequence_id ? `/sequences/${f.sequence_id}` : "/sequences"}>Open sequence builder →</Link>}>
                  <select className="select" value={f.sequence_id ?? ""} onChange={(e) => set({ sequence_id: e.target.value || null })}>
                    <option value="">— Choose a sequence —</option>
                    {seqs.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
            </div>
          </article>

          <article className="card">
            <h3>2 · Who to send to</h3>
            <div className="field mt-4"><span>Lead lists</span>
              <Picker items={lists.data ?? []} value={f.list_ids} onChange={(v) => set({ list_ids: v })} empty={<>No lists — <Link className="text-pink" href="/leads">import leads</Link></>}
                render={(l) => <span className="flex justify-between gap-2"><span className="truncate-1">{l.name}</span><small className="text-muted">{num(l.contact_count)}</small></span>} />
            </div>
            <p className="text-[11.5px] text-muted mt-2">Unsubscribed, suppressed and verified-invalid emails are excluded automatically.</p>
          </article>

          <article className="card">
            <h3>3 · Send from</h3>
            <div className="field mt-4"><span>Mailboxes (rotated)</span>
              <Picker items={mbs.data ?? []} value={f.mailbox_ids} onChange={(v) => set({ mailbox_ids: v })} empty={<>No mailboxes — <Link className="text-pink" href="/mailboxes">connect one</Link></>}
                render={(m) => <span className="flex items-center gap-2.5"><ProviderBadge provider={m.provider} /><span className="truncate-1 flex-1">{m.email}</span><small className="text-muted">{m.daily_limit}/day</small>{m.status !== "active" && <StatusBadge status={m.status} />}</span>} />
            </div>
          </article>

          <article className="card">
            <h3>4 · When</h3>
            <div className="grid gap-4 mt-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
              <Field label="Time zone"><select className="select" value={sch.timezone} onChange={(e) => set({ schedule: { ...sch, timezone: e.target.value } })}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</select></Field>
              <Field label="From"><input className="input" type="time" value={sch.start} onChange={(e) => set({ schedule: { ...sch, start: e.target.value } })} /></Field>
              <Field label="To"><input className="input" type="time" value={sch.end} onChange={(e) => set({ schedule: { ...sch, end: e.target.value } })} /></Field>
              <Field label="Start date (optional)"><input className="input" type="datetime-local" value={sch.start_at?.slice(0, 16) ?? ""} onChange={(e) => set({ schedule: { ...sch, start_at: e.target.value ? new Date(e.target.value).toISOString() : null } })} /></Field>
            </div>
            <div className="field mt-4"><span>Working days <small>— also used by “working days only” Wait nodes</small></span>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS.map((d, i) => (
                  <button key={d} type="button" className={`chip ${sch.days.includes(i) ? "on" : ""}`} onClick={() => set({ schedule: { ...sch, days: sch.days.includes(i) ? sch.days.filter((x) => x !== i) : [...sch.days, i].sort() } })}><span>{d}</span></button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 mt-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Max emails per day (this campaign)"><input className="input" type="number" min={1} value={f.settings.daily_cap} onChange={(e) => set({ settings: { ...f.settings, daily_cap: +e.target.value } })} /></Field>
              <label className="flex items-center gap-3 text-[13.5px] mt-6"><Toggle on={f.settings.stop_on_reply} onChange={(v) => set({ settings: { ...f.settings, stop_on_reply: v } })} label="Stop on reply" /> Stop sequence when a lead replies</label>
            </div>
          </article>
        </div>

        <aside className="card" style={{ alignSelf: "start", position: "sticky", top: 16 }}>
          <div className="flex items-center justify-between"><h3>Pre-flight</h3><button className="btn btn-sm btn-ghost" onClick={() => preflight.mutate()} disabled={preflight.isPending}>{preflight.isPending ? <Spinner size={14} /> : "Re-check"}</button></div>
          {!pf ? <Skeleton h={140} className="mt-4" /> : (
            <div className="flex flex-col gap-3 mt-4 text-[13px]">
              {pf.errors.length ? pf.errors.map((e) => <div key={e} className="flex gap-2 text-red"><CircleExclamationPoint width={16} className="flex-none mt-0.5" />{e}</div>) : <div className="flex gap-2 text-green"><CircleCheck width={16} /> Ready to launch</div>}
              <div className="tile grid grid-cols-2 gap-3">
                <div><div className="text-[20px] font-medium">{num(pf.audience)}</div><div className="text-[11.5px] text-muted">sendable leads</div></div>
                <div><div className="text-[20px] font-medium">{num(pf.mailbox_capacity_per_day)}</div><div className="text-[11.5px] text-muted">mailbox capacity / day</div></div>
                <div className="col-span-2"><div className="text-[12px] text-txt-2">Your remaining quota today: <b>{num(pf.capacity_today)}</b> emails</div></div>
              </div>
              {pf.variables.length > 0 && <div className="text-[12px] text-txt-2">Variables used: {pf.variables.map((v) => <span key={v} className="badge b-pink mr-1 mb-1">{`{{${v}}}`}</span>)}</div>}
              {pf.missing.length > 0 && (
                <div className="tile" style={{ boxShadow: "inset 0 0 0 1px rgba(245,194,107,.4)" }}>
                  <b className="font-medium text-amber text-[12.5px]">{num(pf.leads_missing)} leads are missing values</b>
                  {pf.missing.map((m) => <div key={m.variable} className="text-[12px] text-txt-2 mt-1">{`{{${m.variable}}}`} — empty for {num(m.leads)} leads</div>)}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <Modal open={launchOpen} onClose={() => setLaunchOpen(false)} title="Launch campaign" sub={pf ? `${num(pf.audience)} leads will be enrolled` : ""}
        footer={<><button className="btn btn-dark" onClick={() => setLaunchOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!!pf?.errors.length || launch.isPending} onClick={() => launch.mutate()}>{launch.isPending ? <Spinner /> : <><Rocket /> Launch now</>}</button></>}>
        {pf?.errors.length ? <div className="flex flex-col gap-2">{pf.errors.map((e) => <div key={e} className="text-red text-[13px]">• {e}</div>)}</div> : (
          <div className="flex flex-col gap-3 text-[13.5px]">
            {pf && pf.leads_missing > 0 ? (
              <>
                <p className="text-txt-2">{num(pf.leads_missing)} leads are missing template variables. What should happen?</p>
                {([["fallback", "Send anyway — use fallbacks / leave blank"], ["skip", "Skip those leads"], ["block", "Don't launch — I'll fix the data"]] as const).map(([v, l]) => (
                  <label key={v} className="check tile" style={{ padding: "10px 12px" }}><input type="radio" name="policy" checked={policy === v} onChange={() => setPolicy(v)} /> {l}</label>
                ))}
              </>
            ) : <p className="text-txt-2">Everything looks good. Emails go out within the sending window, respecting each mailbox&apos;s daily limit and delays.</p>}
          </div>
        )}
      </Modal>
    </>
  );
}

function Live({ c }: { c: Campaign }) {
  const qc = useQueryClient();
  const [state, setState] = useState("");
  const [eng, setEng] = useState("");
  const ccs = useQuery({ queryKey: ["cc", c.id, state, eng], queryFn: () => get<Paged<CC>>(`/campaigns/${c.id}/contacts?size=100${state ? `&state=${state}` : ""}${eng ? `&engagement=${eng}` : ""}`), refetchInterval: 15_000 });
  const steps = useQuery({ queryKey: ["steps", c.id], queryFn: () => get<Step[]>(`/campaigns/${c.id}/steps`), refetchInterval: 30_000 });
  const act = useMutation({
    mutationFn: (a: "pause" | "launch") => post<Campaign>(`/campaigns/${c.id}/${a}`, a === "launch" ? { missing_policy: "fallback" } : undefined),
    onSuccess: (x) => { qc.setQueryData(["campaign", c.id], x); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
    onError: toast.err,
  });
  const s = c.stats;
  const tiles = [["Leads", s.contacts, ""], ["Sent", s.sent, ""], ["Opened", s.opened, pct(s.opened, s.sent)], ["Clicked", s.clicked, pct(s.clicked, s.sent)], ["Replied", s.replied, pct(s.replied, s.sent)], ["Bounced", s.bounced, pct(s.bounced, s.sent)]] as const;

  return (
    <>
      <header className="head in">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/campaigns" className="btn btn-icon btn-dark" aria-label="Back"><ArrowLeft /></Link>
          <div className="min-w-0">
            <h1 className="truncate-1">{c.name}</h1>
            <p>{c.kind === "sequence" ? "Sequence" : "Single template"} · started {ago(c.started_at)} · {c.schedule.timezone} {c.schedule.start}–{c.schedule.end}</p>
          </div>
          <StatusBadge status={c.status} />
        </div>
        <div className="flex gap-2">
          <Link href={`/campaigns/${c.id}/analytics`} className="btn btn-dark"><ChartColumn /> Analytics</Link>
          {c.status === "running" && <button className="btn btn-dark" onClick={() => act.mutate("pause")}><Pause /> Pause</button>}
          {c.status === "paused" && <button className="btn btn-primary" onClick={() => act.mutate("launch")}><Play /> Resume</button>}
        </div>
      </header>

      <div className="grid gap-3 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {tiles.map(([l, v, p], i) => (
          <article key={l} className={`card ${i === 0 ? "glow" : ""}`}>
            <div className="text-[12.5px] text-txt-2">{l}</div>
            <div className="text-[26px] font-medium mt-2">{num(v)}</div>
            {p && <div className="text-[12px] text-muted">{p}</div>}
          </article>
        ))}
      </div>
      <article className="card in">
        <div className="flex justify-between text-[12.5px] mb-2"><span>Progress</span><span>{num(s.contacts - s.live)} / {num(s.contacts)} finished</span></div>
        <Meter value={s.contacts - s.live} max={s.contacts} />
      </article>

      {!!steps.data?.length && (
        <article className="card in">
          <h3>Per step & template</h3>
          <p className="card-sub">When a Send Mail step has several templates, this shows how each random variant performs.</p>
          <table className="table mt-3">
            <thead><tr><th>Step</th><th>Template</th><th>Sent</th><th>Open rate</th><th>Click rate</th><th>Reply rate</th></tr></thead>
            <tbody>{steps.data.map((x, i) => <tr key={i}><td className="text-txt-2">{x.node_id}</td><td>{x.template ?? "—"}</td><td>{num(x.sent)}</td><td>{pct(x.opened, x.sent)}</td><td>{pct(x.clicked, x.sent)}</td><td>{pct(x.replied, x.sent)}</td></tr>)}</tbody>
          </table>
        </article>
      )}

      <article className="card in">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3>Leads{ccs.data ? <small className="text-muted text-[12px] ml-2">{num(ccs.data.total)}</small> : null}</h3>
          <div className="flex gap-2 flex-wrap">
            <Seg value={eng} onChange={setEng} options={[{ value: "", label: "Any" }, { value: "opened", label: "Opened" }, { value: "unopened", label: "Not opened" }, { value: "clicked", label: "Clicked" }]} />
            <Seg value={state} onChange={setState} options={[{ value: "", label: "All" }, { value: "active", label: "Active" }, { value: "waiting", label: "Waiting" }, { value: "replied", label: "Replied" }, { value: "done", label: "Done" }, { value: "bounced", label: "Bounced" }]} />
          </div>
        </div>
        {!ccs.data?.items.length ? <Empty title="No leads in this state" /> : (
          <div className="overflow-x-auto mt-3">
            <table className="table">
              <thead><tr><th>Lead</th><th>State</th><th>Engagement</th><th>Step</th><th>Emails sent</th><th>Next action</th></tr></thead>
              <tbody>
                {ccs.data.items.map((x) => (
                  <tr key={x.id}>
                    <td><div>{x.email}</div><div className="text-[11.5px] text-muted">{[x.first_name, x.company].filter(Boolean).join(" · ")}</div></td>
                    <td><StatusBadge status={x.state} />{x.error && <div className="text-[11px] text-red mt-1 max-w-[220px] truncate-1" title={x.error}>{x.error}</div>}</td>
                    <td><Engagement x={x} /></td>
                    <td className="text-txt-2 text-[12.5px]">{x.current_node ?? "—"}</td>
                    <td>{x.steps_sent}</td>
                    <td className="text-txt-2 text-[12.5px]">{x.next_run_at && ["active", "waiting", "pending"].includes(x.state) ? (new Date(x.next_run_at) > new Date() ? `in ${until(x.next_run_at)}` : "now") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </>
  );
}

export default function CampaignView() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["campaign", id], queryFn: () => get<Campaign>(`/campaigns/${id}`), refetchInterval: (x) => (x.state.data?.status === "running" ? 15_000 : false) });
  if (!q.data) return <Skeleton h={500} />;
  return q.data.status === "draft" ? <Setup c={q.data} /> : <Live c={q.data} />;
}
