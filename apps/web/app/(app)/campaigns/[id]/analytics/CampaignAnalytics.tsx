"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, Bot, Clock, Eye, Link2, MousePointerClick, Reply, Send, ShieldAlert, TriangleExclamationPoint, UserMinus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { PerfChart, type Metric, type Point } from "@/components/PerfChart";
import { Empty, Meter, Seg, Skeleton, StatusBadge } from "@/components/ui";
import { get } from "@/lib/api";
import { DAYS, ago, num, pct } from "@/lib/format";
import type { Campaign, Paged } from "@/lib/types";

interface Summary {
  leads: number; contacted: number; sent: number; delivered: number; bounced: number; failed: number; opened: number; opens: number;
  clicked: number; clicks: number; replied: number; unsubscribed: number; median_open_seconds: number | null; median_reply_seconds: number | null;
}
interface Analytics {
  timezone: string;
  summary: Summary;
  filtered: { kind: "open" | "click"; reason: string; count: number }[];
  states: Record<string, number>;
  timeline: (Point & { clicked: number })[];
  heatmap: { dow: number; hour: number; n: number }[];
  steps: { node_id: string | null; template: string | null; sent: number; opened: number; clicked: number; replied: number; bounced: number }[];
  mailboxes: { mailbox_id: string | null; email: string; sent: number; opened: number; replied: number; bounced: number }[];
  links: { url: string; clicks: number; unique: number }[];
  activity: { kind: string; at: string; email: string | null; url: string | null; machine: string | null }[];
}
interface Msg { id: string; to: string; subject: string; status: string; sent_at: string; opened_at: string | null; clicked_at: string | null; replied_at: string | null; open_count: number; click_count: number }

function dur(s: number | null) {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${(s / 86400).toFixed(1)}d`;
}

function Kpi({ label, value, sub, icon, tone }: { label: string; value: string; sub?: string; icon: ReactNode; tone?: "red" }) {
  return (
    <article className="card">
      <div className="flex items-center justify-between text-[12.5px] text-txt-2"><span>{label}</span><span className="text-muted [&>svg]:w-4 [&>svg]:h-4">{icon}</span></div>
      <div className={`text-[26px] font-medium mt-2 ${tone === "red" ? "text-red" : ""}`}>{value}</div>
      {sub && <div className="text-[12px] text-muted">{sub}</div>}
    </article>
  );
}

/** Sent → Delivered → Opened → Clicked → Replied, every bar relative to emails sent. */
function Funnel({ s }: { s: Summary }) {
  const rows = [["Sent", s.sent], ["Delivered", s.delivered], ["Opened", s.opened], ["Clicked", s.clicked], ["Replied", s.replied]] as const;
  return (
    <div className="flex flex-col gap-3 mt-4">
      {rows.map(([l, v], i) => (
        <div key={l}>
          <div className="flex justify-between text-[12.5px] mb-1.5">
            <span className="text-txt-2">{l}</span>
            <span><b className="font-medium">{num(v)}</b> <span className="text-muted">{i === 0 ? "" : `· ${pct(v, i === 1 ? s.sent : s.delivered)}`}</span></span>
          </div>
          <Meter value={v} max={s.sent} />
        </div>
      ))}
      <p className="text-[11.5px] text-muted">Open, click and reply rates are out of delivered emails.</p>
    </div>
  );
}

/** First opens by weekday × hour, single-hue intensity; hover a cell for its count. */
function Heatmap({ cells, tz }: { cells: Analytics["heatmap"]; tz: string }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; n: number } | null>(null);
  const grid = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.n]));
  const max = Math.max(1, ...cells.map((c) => c.n));
  const best = cells.length ? cells.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <>
      <div className="text-[12px] text-txt-2 mt-1 min-h-[18px]">
        {hover ? <>{DAYS[hover.dow]} {hh(hover.hour)}–{hh((hover.hour + 1) % 24)} · <b className="font-medium text-txt">{num(hover.n)}</b> first opens</>
          : best ? <>Most opens: <b className="font-medium text-txt">{DAYS[best.dow]} around {hh(best.hour)}</b> ({tz})</> : `Times shown in ${tz}`}
      </div>
      <div className="overflow-x-auto mt-3">
        <div style={{ display: "grid", gridTemplateColumns: "34px repeat(24, minmax(14px, 1fr))", gap: 3, minWidth: 460 }} onMouseLeave={() => setHover(null)}>
          {DAYS.map((d, dow) => (
            <div key={d} className="contents">
              <div className="text-[10.5px] text-muted self-center">{d}</div>
              {Array.from({ length: 24 }, (_, hour) => {
                const n = grid.get(`${dow}-${hour}`) ?? 0;
                return (
                  <div key={hour} onMouseEnter={() => setHover({ dow, hour, n })} aria-label={`${d} ${hh(hour)}: ${n} opens`}
                    style={{ aspectRatio: "1", borderRadius: 4, background: n ? `rgba(238,178,220,${0.15 + 0.85 * (n / max)})` : "rgba(255,255,255,.05)",
                      boxShadow: hover?.dow === dow && hover.hour === hour ? "0 0 0 1.5px var(--txt)" : undefined }} />
                );
              })}
            </div>
          ))}
          <div />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-[10px] text-muted text-center">{h % 6 === 0 ? h : ""}</div>)}
        </div>
      </div>
    </>
  );
}

const KIND: Record<string, [string, ReactNode, string]> = {
  open: ["Opened", <Eye key="o" />, "b-pink"], click: ["Clicked", <MousePointerClick key="c" />, "b-blue"],
  reply: ["Replied", <Reply key="r" />, "b-green"], bounce: ["Bounced", <TriangleExclamationPoint key="b" />, "b-red"],
  unsubscribe: ["Unsubscribed", <UserMinus key="u" />, "b-amber"], manual_reply: ["You replied", <Send key="m" />, "b-gray"],
};

export default function CampaignAnalytics() {
  const { id } = useParams<{ id: string }>();
  const [metric, setMetric] = useState<Metric>("sent");
  const camp = useQuery({ queryKey: ["campaign", id], queryFn: () => get<Campaign>(`/campaigns/${id}`) });
  const a = useQuery({ queryKey: ["analytics", id], queryFn: () => get<Analytics>(`/campaigns/${id}/analytics`), refetchInterval: 30_000 });
  const msgs = useQuery({ queryKey: ["messages", id], queryFn: () => get<Paged<Msg>>(`/campaigns/${id}/messages?size=50`), refetchInterval: 30_000 });

  const c = camp.data, d = a.data, s = d?.summary;
  const filteredOpens = d?.filtered.filter((f) => f.kind === "open").reduce((n, f) => n + f.count, 0) ?? 0;
  const filteredClicks = d?.filtered.filter((f) => f.kind === "click").reduce((n, f) => n + f.count, 0) ?? 0;
  const reasons = Object.entries((d?.filtered ?? []).reduce<Record<string, number>>((m, f) => ({ ...m, [f.reason]: (m[f.reason] ?? 0) + f.count }), {})).sort((x, y) => y[1] - x[1]);
  const states = Object.entries(d?.states ?? {}).sort((x, y) => y[1] - x[1]);

  return (
    <>
      <header className="head in">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/campaigns/${id}`} className="btn btn-icon btn-dark" aria-label="Back to campaign"><ArrowLeft /></Link>
          <div className="min-w-0">
            <h1 className="truncate-1">Analytics <span className="accent">{c?.name ?? ""}</span></h1>
            <p>{c ? `${c.kind === "sequence" ? "Sequence" : "Single template"} · started ${ago(c.started_at)}` : " "}{d ? ` · times in ${d.timezone}` : ""}</p>
          </div>
          {c && <StatusBadge status={c.status} />}
        </div>
      </header>

      {!s ? <Skeleton h={520} /> : (
        <>
          <div className="grid gap-3 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <Kpi label="Emails sent" value={num(s.sent)} sub={`${num(s.contacted)} of ${num(s.leads)} leads contacted`} icon={<Send />} />
            <Kpi label="Open rate" value={pct(s.opened, s.delivered)} sub={`${num(s.opened)} unique · ${num(s.opens)} total opens`} icon={<Eye />} />
            <Kpi label="Click rate" value={pct(s.clicked, s.delivered)} sub={`${num(s.clicked)} unique · ${num(s.clicks)} total clicks`} icon={<MousePointerClick />} />
            <Kpi label="Reply rate" value={pct(s.replied, s.delivered)} sub={`${num(s.replied)} replies`} icon={<Reply />} />
            <Kpi label="Bounce rate" value={pct(s.bounced, s.sent)} sub={`${num(s.bounced)} bounced${s.failed ? ` · ${num(s.failed)} failed` : ""}`} icon={<TriangleExclamationPoint />} tone={s.sent && s.bounced / s.sent > 0.03 ? "red" : undefined} />
            <Kpi label="Unsubscribed" value={num(s.unsubscribed)} sub={pct(s.unsubscribed, s.delivered)} icon={<UserMinus />} />
          </div>

          {(filteredOpens > 0 || filteredClicks > 0) && (
            <article className="card in" style={{ boxShadow: "inset 0 0 0 1px rgba(142,197,255,.25)" }}>
              <div className="flex gap-3 items-start">
                <ShieldAlert className="text-blue flex-none mt-0.5" width={18} />
                <div className="text-[13px]">
                  <b className="font-medium">Filtered {num(filteredOpens)} automated open{filteredOpens === 1 ? "" : "s"}{filteredClicks ? ` and ${num(filteredClicks)} click${filteredClicks === 1 ? "" : "s"}` : ""}</b>
                  <p className="text-txt-2 mt-1">Security scanners, Apple Mail Privacy Protection and delivery-time prefetches load tracking pixels without a person reading the email. They aren&apos;t counted in the rates above.</p>
                  <div className="flex gap-1.5 flex-wrap mt-2">{reasons.map(([r, n]) => <span key={r} className="badge b-gray"><Bot /> {r} · {num(n)}</span>)}</div>
                </div>
              </div>
            </article>
          )}

          <article className="card in flex flex-col" style={{ minHeight: 340 }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div><h3>Activity over time</h3><p className="card-sub">Each metric is counted on the day it happened</p></div>
              <Seg value={metric} onChange={setMetric} options={[{ value: "sent", label: "Sent" }, { value: "opened", label: "Opened" }, { value: "clicked", label: "Clicked" }, { value: "replied", label: "Replied" }]} />
            </div>
            <div className="mt-4 flex-1">
              {d.timeline.length ? <PerfChart points={d.timeline} range="6M" metric={metric} /> : <Empty icon={<Activity />} title="Nothing sent yet" />}
            </div>
          </article>

          <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            <article className="card"><h3>Funnel</h3><Funnel s={s} /></article>
            <article className="card">
              <h3>Timing</h3>
              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="tile"><Clock width={16} className="text-muted" /><div className="text-[20px] font-medium mt-2">{dur(s.median_open_seconds)}</div><div className="text-[11.5px] text-muted">median time to first open</div></div>
                <div className="tile"><Reply width={16} className="text-muted" /><div className="text-[20px] font-medium mt-2">{dur(s.median_reply_seconds)}</div><div className="text-[11.5px] text-muted">median time to reply</div></div>
              </div>
              <h3 className="mt-5 text-[14px]">Leads by status</h3>
              <div className="flex flex-col gap-2.5 mt-3">
                {states.length ? states.map(([st, n]) => (
                  <div key={st} className="grid items-center gap-3 text-[12.5px]" style={{ gridTemplateColumns: "96px 1fr 48px" }}>
                    <StatusBadge status={st} /><Meter value={n} max={s.leads} /><span className="text-right">{num(n)}</span>
                  </div>
                )) : <span className="text-[12.5px] text-muted">No leads enrolled</span>}
              </div>
            </article>
            <article className="card">
              <h3>When leads open</h3>
              {d.heatmap.length ? <Heatmap cells={d.heatmap} tz={d.timezone} /> : <Empty icon={<Eye />} title="No opens yet" />}
            </article>
          </div>

          {d.steps.length > 0 && (
            <article className="card in">
              <h3>Per step & template</h3>
              <p className="card-sub">How each step — and each random template variant — performs.</p>
              <div className="overflow-x-auto mt-3">
                <table className="table">
                  <thead><tr><th>Step</th><th>Template</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Replied</th><th>Bounced</th></tr></thead>
                  <tbody>{d.steps.map((x, i) => (
                    <tr key={i}>
                      <td className="text-txt-2">{x.node_id ?? "—"}</td><td>{x.template ?? "—"}</td><td>{num(x.sent)}</td>
                      <td>{pct(x.opened, x.sent)} <small className="text-muted">({num(x.opened)})</small></td>
                      <td>{pct(x.clicked, x.sent)} <small className="text-muted">({num(x.clicked)})</small></td>
                      <td>{pct(x.replied, x.sent)} <small className="text-muted">({num(x.replied)})</small></td>
                      <td>{pct(x.bounced, x.sent)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </article>
          )}

          <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
            <article className="card">
              <h3>Mailboxes</h3>
              {!d.mailboxes.length ? <Empty title="No sends yet" /> : (
                <div className="overflow-x-auto mt-3">
                  <table className="table">
                    <thead><tr><th>Mailbox</th><th>Sent</th><th>Open</th><th>Reply</th><th>Bounce</th></tr></thead>
                    <tbody>{d.mailboxes.map((m) => (
                      <tr key={m.mailbox_id ?? m.email}><td className="max-w-[220px] truncate-1">{m.email}</td><td>{num(m.sent)}</td><td>{pct(m.opened, m.sent)}</td><td>{pct(m.replied, m.sent)}</td><td className={m.sent && m.bounced / m.sent > 0.03 ? "text-red" : ""}>{pct(m.bounced, m.sent)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </article>
            <article className="card">
              <h3>Top links</h3>
              {!d.links.length ? <Empty icon={<Link2 />} title="No link clicks yet">Turn on click tracking in a template to see which links get clicked.</Empty> : (
                <div className="overflow-x-auto mt-3">
                  <table className="table">
                    <thead><tr><th>Link</th><th>Clicks</th><th>Unique</th></tr></thead>
                    <tbody>{d.links.map((l) => (
                      <tr key={l.url}><td className="max-w-[280px]"><a href={l.url} target="_blank" rel="noreferrer" className="truncate-1 block text-pink" title={l.url}>{l.url.replace(/^https?:\/\//, "")}</a></td><td>{num(l.clicks)}</td><td>{num(l.unique)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </article>
          </div>

          <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)" }}>
            <article className="card">
              <h3>Sent emails{msgs.data ? <small className="text-muted text-[12px] ml-2">{num(msgs.data.total)}</small> : null}</h3>
              {!msgs.data?.items.length ? <Empty icon={<Send />} title="No emails sent yet" /> : (
                <div className="overflow-x-auto mt-3" style={{ maxHeight: 520, overflowY: "auto" }}>
                  <table className="table">
                    <thead><tr><th>To</th><th>Subject</th><th>Sent</th><th>Engagement</th></tr></thead>
                    <tbody>{msgs.data.items.map((m) => (
                      <tr key={m.id}>
                        <td className="max-w-[200px] truncate-1">{m.to}</td>
                        <td className="max-w-[240px] truncate-1 text-txt-2" title={m.subject}>{m.subject}</td>
                        <td className="text-txt-2 text-[12.5px] whitespace-nowrap">{ago(m.sent_at)}</td>
                        <td>
                          <div className="flex gap-1 flex-wrap">
                            {m.status !== "sent" ? <StatusBadge status={m.status} /> : !m.opened_at && !m.clicked_at && !m.replied_at ? <span className="badge b-gray">Not opened</span> : null}
                            {m.opened_at && <span className="badge b-pink" title={new Date(m.opened_at).toLocaleString()}><Eye /> Opened{m.open_count > 1 ? ` ×${m.open_count}` : ""}</span>}
                            {m.clicked_at && <span className="badge b-blue"><MousePointerClick /> Clicked</span>}
                            {m.replied_at && <span className="badge b-green"><Reply /> Replied</span>}
                          </div>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </article>
            <article className="card" style={{ alignSelf: "start" }}>
              <h3>Recent activity</h3>
              {!d.activity.length ? <Empty icon={<Activity />} title="No activity yet" /> : (
                <ul className="flex flex-col gap-2.5 mt-3" style={{ maxHeight: 520, overflowY: "auto" }}>
                  {d.activity.map((e, i) => {
                    const [label, icon, cls] = KIND[e.kind] ?? [e.kind, null, "b-gray"];
                    return (
                      <li key={i} className="flex items-start gap-2.5 text-[12.5px]" style={{ opacity: e.machine ? 0.55 : 1 }}>
                        <span className={`badge ${e.machine ? "b-gray" : cls}`}>{e.machine ? <Bot /> : icon} {label}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate-1">{e.email ?? "—"}</div>
                          <div className="text-[11px] text-muted truncate-1">{e.machine ? `Ignored: ${e.machine}` : e.url ?? ""}</div>
                        </div>
                        <span className="text-[11px] text-muted flex-none">{ago(e.at)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </div>
        </>
      )}
    </>
  );
}
