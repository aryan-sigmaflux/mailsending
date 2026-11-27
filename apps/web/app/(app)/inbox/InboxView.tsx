"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Ban, ChartColumn, Eye, Funnel, History, Inbox, Layers, Megaphone, MousePointerClick, Reply, Search, Send, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ContactHistoryModal } from "@/components/outreach";
import { toast } from "@/components/toast";
import { Empty, Field, Modal, PageHeader, Seg, Skeleton, Spinner, StatusBadge } from "@/components/ui";
import { get, post } from "@/lib/api";
import { ago, num, stageLabel } from "@/lib/format";
import type { DncEntry, Mailbox, Paged, Stage } from "@/lib/types";

interface Base {
  id: string; to: string; name: string; company: string | null; mailbox: string | null;
  campaign: string | null; campaign_id: string | null; campaign_kind: string | null; stage: Stage | null; template: string | null;
  subject: string; sent_at: string;
}
interface ReplyItem extends Base { reply: string | null; replied_at: string; sent_body: string }
interface SentItem extends Base {
  status: string; opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number; replied_at: string | null;
}
interface SentDetail {
  id: string; to: string; contact_id: string | null; subject: string; body: string; status: string; error: string | null;
  opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number; clicks: { url: string; at: string }[];
  replied_at: string | null; reply: string | null; dnc: DncEntry | null;
}
interface CampaignCounts { id: string | null; name: string; kind: string | null; count: number; stages: (Stage & { count: number })[] }

type View = "replies" | "sent";
type Key = "campaign" | "stage" | "mailbox" | "domain" | "status";
type Filters = Record<Key, string>;
const KEYS: Key[] = ["campaign", "stage", "mailbox", "domain", "status"];
const DIRECT = "direct"; // campaign filter value for one-off emails composed outside a campaign
const SIZE = 50;

const STATUSES = [
  ["", "Any status"], ["opened", "Opened"], ["clicked", "Clicked a link"], ["replied", "Replied"],
  ["unopened", "Not opened yet"], ["bounced", "Bounced"], ["failed", "Failed to send"],
] as const;

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** Query string shared by the replies and sent endpoints. */
function apiQs(f: Filters, view: View, extra: Record<string, string> = {}) {
  const p = new URLSearchParams(extra);
  if (f.campaign === DIRECT) p.set("direct", "true");
  else if (f.campaign) p.set("campaign_id", f.campaign);
  if (f.stage) p.set("node_id", f.stage);
  if (f.mailbox) p.set("mailbox_id", f.mailbox);
  if (f.domain) p.set("domain", f.domain);
  if (view === "sent" && f.status) p.set("status", f.status);
  return p.toString();
}

function FiltersOverlay({ open, onClose, view, value, mailboxes, onApply }: {
  open: boolean; onClose: () => void; view: View; value: Filters; mailboxes: Mailbox[]; onApply: (f: Filters) => void;
}) {
  const [d, setD] = useState(value);
  const camps = useQuery({
    queryKey: ["inbox-campaigns", view, d.mailbox, d.domain], enabled: open,
    queryFn: () => get<CampaignCounts[]>(`/inbox/campaigns?${new URLSearchParams({ view, ...(d.mailbox && { mailbox_id: d.mailbox }), ...(d.domain && { domain: d.domain }) })}`),
  });
  const domains = [...new Set(mailboxes.map((m) => domainOf(m.email)))].sort();
  const mbs = d.domain ? mailboxes.filter((m) => domainOf(m.email) === d.domain) : mailboxes;
  const options = camps.data ?? [];
  const current = options.find((c) => (c.id ?? DIRECT) === d.campaign);
  const unit = view === "replies" ? "replies" : "sent";
  const set = (k: Partial<Filters>) => setD((x) => ({ ...x, ...k, ...("campaign" in k ? { stage: "" } : {}) }));

  return (
    <Modal open={open} onClose={onClose} title="Filters" sub={view === "replies" ? "Narrow down the replies you see" : "Narrow down the emails that went out"}
      footer={<>
        <button className="btn btn-dark" onClick={() => setD({ campaign: "", stage: "", mailbox: "", domain: "", status: "" })}>Clear all</button>
        <button className="btn btn-primary" onClick={() => { onApply(d); onClose(); }}>Apply filters</button>
      </>}>
      <div className="flex flex-col gap-4">
        <Field label="Campaign">
          <select className="select" value={d.campaign} onChange={(e) => set({ campaign: e.target.value })}>
            <option value="">All campaigns</option>
            {options.map((c) => <option key={c.id ?? DIRECT} value={c.id ?? DIRECT}>{c.id ? c.name : "One-off emails (no campaign)"} ({num(c.count)} {unit})</option>)}
            {d.campaign && camps.data && !current && <option value={d.campaign}>Selected campaign (0)</option>}
          </select>
        </Field>
        {current?.kind === "sequence" && current.stages.length > 0 && (
          <Field label="Step">
            <select className="select" value={d.stage} onChange={(e) => set({ stage: e.target.value })}>
              <option value="">All steps</option>
              {current.stages.map((s) => <option key={s.node_id ?? ""} value={s.node_id ?? ""}>{stageLabel(s, current.kind)} ({num(s.count)})</option>)}
            </select>
          </Field>
        )}
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Sending domain">
            <select className="select" value={d.domain} onChange={(e) => {
              const dom = e.target.value;
              const keep = !dom || mailboxes.find((m) => m.id === d.mailbox && domainOf(m.email) === dom);
              set({ domain: dom, ...(keep ? {} : { mailbox: "" }) });
            }}>
              <option value="">All domains</option>
              {domains.map((x) => <option key={x} value={x}>{x} ({mailboxes.filter((m) => domainOf(m.email) === x).length} mailbox{mailboxes.filter((m) => domainOf(m.email) === x).length === 1 ? "" : "es"})</option>)}
            </select>
          </Field>
          <Field label="Mailbox">
            <select className="select" value={d.mailbox} onChange={(e) => set({ mailbox: e.target.value })}>
              <option value="">{d.domain ? `All on ${d.domain}` : "All mailboxes"}</option>
              {mbs.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </Field>
        </div>
        {view === "sent" && (
          <Field label="What the lead did">
            <select className="select" value={d.status} onChange={(e) => set({ status: e.target.value })}>
              {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function Engagement({ m }: { m: Pick<SentItem, "status" | "opened_at" | "open_count" | "click_count" | "replied_at"> }) {
  if (m.status === "bounced" || m.status === "failed") return <StatusBadge status={m.status} />;
  return (
    <span className="inline-flex gap-2.5 text-[11.5px]">
      <span className={m.opened_at ? "text-txt-2" : "text-faint"} title={m.opened_at ? `Opened ${m.open_count}×` : "Not opened"}><Eye width={12} className="inline -mt-0.5" /> {m.open_count}</span>
      <span className={m.click_count ? "text-pink" : "text-faint"} title={`${m.click_count} link clicks`}><MousePointerClick width={12} className="inline -mt-0.5" /> {m.click_count}</span>
      <span className={m.replied_at ? "text-green" : "text-faint"} title={m.replied_at ? "Replied" : "No reply"}><Reply width={12} className="inline -mt-0.5" /></span>
    </span>
  );
}

function SentPane({ item }: { item: SentItem }) {
  const [history, setHistory] = useState(false);
  const q = useQuery({ queryKey: ["sent-message", item.id], queryFn: () => get<SentDetail>(`/inbox/messages/${item.id}`) });
  const d = q.data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3>{item.subject || "(no subject)"}</h3>
        <p className="card-sub">To {item.name ? `${item.name} · ` : ""}{item.to}{item.company ? ` · ${item.company}` : ""}{item.mailbox ? ` — from ${item.mailbox}` : ""} · {new Date(item.sent_at).toLocaleString()}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {item.campaign_id ? (
            <Link href={`/campaigns/${item.campaign_id}/analytics`} className="badge b-pink" title="Open campaign analytics"><Megaphone /> {item.campaign} <ChartColumn /></Link>
          ) : <span className="badge b-gray"><Megaphone /> One-off email</span>}
          {item.stage && <span className="badge b-gray"><Layers /> {stageLabel(item.stage, item.campaign_kind)}</span>}
          {item.template && <span className="badge b-gray">Template: {item.template}</span>}
          {item.status !== "sent" && <StatusBadge status={item.status} />}
          {d?.dnc && <span className="badge b-red" title={d.dnc.entry}><Ban /> {d.dnc.label}</span>}
          <span className="flex-1" />
          {d?.contact_id && <button className="btn btn-sm btn-ghost" onClick={() => setHistory(true)}><History /> Contact history</button>}
        </div>
      </div>
      {!d ? <Skeleton h={160} /> : <>
        {d.error && d.status !== "sent" && <div className="tile text-[12.5px] text-red">{d.error}</div>}
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          <div className="tile"><div className="text-[11.5px] text-muted mb-1"><Eye width={12} className="inline -mt-0.5" /> Opens</div><div className="text-[18px] font-medium">{num(d.open_count)}</div><div className="text-[11.5px] text-muted">{d.opened_at ? `first ${ago(d.opened_at)}` : "not opened yet"}</div></div>
          <div className="tile"><div className="text-[11.5px] text-muted mb-1"><MousePointerClick width={12} className="inline -mt-0.5" /> Link clicks</div><div className={`text-[18px] font-medium ${d.clicks.length ? "text-pink" : ""}`}>{num(d.clicks.length)}</div><div className="text-[11.5px] text-muted">{d.clicked_at ? `first ${ago(d.clicked_at)}` : "no clicks"}</div></div>
          <div className="tile"><div className="text-[11.5px] text-muted mb-1"><Reply width={12} className="inline -mt-0.5" /> Reply</div><div className={`text-[18px] font-medium ${d.replied_at ? "text-green" : ""}`}>{d.replied_at ? "Yes" : "No"}</div><div className="text-[11.5px] text-muted">{d.replied_at ? ago(d.replied_at) : "no reply yet"}</div></div>
        </div>
        {d.clicks.length > 0 && (
          <div className="tile">
            <div className="text-[11.5px] text-pink mb-1.5">Links they clicked</div>
            <ul className="text-[12.5px] flex flex-col gap-1">{d.clicks.map((k, i) => <li key={i} className="truncate-1"><a href={k.url} target="_blank" rel="noreferrer" className="link">{k.url}</a> <span className="text-muted">· {ago(k.at)}</span></li>)}</ul>
          </div>
        )}
        {d.reply?.trim() && (
          <div className="tile" style={{ boxShadow: "inset 0 0 0 1px rgba(79,214,127,.3)" }}>
            <div className="text-[11.5px] text-green mb-2">Their reply · {ago(d.replied_at)}</div>
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{d.reply}</pre>
          </div>
        )}
        <div className="preview-frame" dangerouslySetInnerHTML={{ __html: d.body }} />
      </>}
      {history && <ContactHistoryModal contactId={d?.contact_id ?? null} onClose={() => setHistory(false)} />}
    </div>
  );
}

function ReplyPane({ sel }: { sel: ReplyItem }) {
  const [text, setText] = useState("");
  const reply = useMutation({
    mutationFn: () => post(`/inbox/${sel.id}/reply`, { body_html: text.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;") || "&nbsp;"}</p>`).join("") }),
    onSuccess: () => { toast.ok(`Reply sent to ${sel.to}`); setText(""); },
    onError: toast.err,
  });
  return (
    <div className="flex flex-col gap-4 h-full">
      <div>
        <h3>{sel.subject}</h3>
        <p className="card-sub">{sel.name ? `${sel.name} · ` : ""}{sel.to}{sel.company ? ` · ${sel.company}` : ""}{sel.mailbox ? ` — via ${sel.mailbox}` : ""}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {sel.campaign_id ? (
            <Link href={`/campaigns/${sel.campaign_id}/analytics`} className="badge b-pink" title="Open campaign analytics"><Megaphone /> {sel.campaign} <ChartColumn /></Link>
          ) : <span className="badge b-gray"><Megaphone /> Direct email</span>}
          {sel.stage && <span className="badge b-gray" title="The email they replied to"><Layers /> Replied to {stageLabel(sel.stage, sel.campaign_kind)}</span>}
          {sel.template && <span className="badge b-gray">Template: {sel.template}</span>}
        </div>
      </div>
      <div className="tile" style={{ boxShadow: "inset 0 0 0 1px rgba(238,178,220,.35)" }}>
        <div className="text-[11.5px] text-pink mb-2">Their reply · {ago(sel.replied_at)}</div>
        {sel.reply?.trim()
          ? <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">{sel.reply}</pre>
          : <p className="text-[13px] text-muted italic">The text of this reply couldn&apos;t be read — open it in the mailbox ({sel.mailbox ?? "inbox"}) to see it.</p>}
      </div>
      <details className="tile">
        <summary className="text-[12px] text-muted cursor-pointer">Your email{sel.stage ? ` (${stageLabel(sel.stage, sel.campaign_kind)})` : ""} · {ago(sel.sent_at)}</summary>
        <div className="preview-frame mt-3" dangerouslySetInnerHTML={{ __html: sel.sent_body }} />
      </details>
      <div className="mt-auto">
        <textarea className="textarea" placeholder={`Reply to ${sel.name || sel.to}…`} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end mt-2"><button className="btn btn-primary" disabled={!text.trim() || reply.isPending} onClick={() => reply.mutate()}>{reply.isPending ? <Spinner /> : <><Send /> Send reply</>}</button></div>
      </div>
    </div>
  );
}

export default function InboxView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view: View = params.get("view") === "sent" ? "sent" : "replies";
  const f = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ""])) as Filters;
  const [selId, setSelId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  /** Filters live in the URL so campaign analytics can link straight to "replies from this campaign / step". */
  function go(next: Partial<Filters & { view: View }>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "view" && v === "replies")) p.set(k, v);
      else p.delete(k);
    }
    if ("campaign" in next && !("stage" in next)) p.delete("stage");
    if (next.view === "replies") p.delete("status");
    setSelId(null);
    setPage(1);
    router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
  }

  const mbs = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });
  const filterQs = apiQs(f, view);
  // Names for the active-filter chips. Every replied email was also sent, so the "sent" list names every campaign.
  const camps = useQuery({ queryKey: ["inbox-campaigns", "sent", "", ""], enabled: !!f.campaign && f.campaign !== DIRECT, queryFn: () => get<CampaignCounts[]>("/inbox/campaigns?view=sent") });
  const replies = useQuery({
    queryKey: ["inbox", filterQs, page], enabled: view === "replies", refetchInterval: 60_000,
    queryFn: () => get<Paged<ReplyItem>>(`/inbox?${apiQs(f, view, { size: String(SIZE), page: String(page) })}`),
  });
  const sent = useQuery({
    queryKey: ["inbox-sent", filterQs, q, page], enabled: view === "sent", refetchInterval: 60_000,
    queryFn: () => get<Paged<SentItem>>(`/inbox/sent?${apiQs(f, view, { size: String(SIZE), page: String(page), ...(q && { q }) })}`),
  });
  const data = view === "replies" ? replies : sent;
  const items = (data.data?.items ?? []) as (ReplyItem | SentItem)[];
  const sel = items.find((i) => i.id === selId) ?? null;

  const camp = camps.data?.find((c) => c.id === f.campaign);
  const mbName = mbs.data?.find((m) => m.id === f.mailbox)?.email;
  const chips: { key: Key; label: string }[] = [
    f.campaign && { key: "campaign" as Key, label: f.campaign === DIRECT ? "One-off emails" : `Campaign: ${camp?.name ?? "…"}` },
    f.stage && { key: "stage" as Key, label: (camp && stageLabel(camp.stages.find((s) => s.node_id === f.stage) ?? null, camp.kind)) || `Step: ${f.stage}` },
    f.domain && { key: "domain" as Key, label: `Domain: ${f.domain}` },
    f.mailbox && { key: "mailbox" as Key, label: `Mailbox: ${mbName ?? "…"}` },
    view === "sent" && f.status && { key: "status" as Key, label: STATUSES.find(([v]) => v === f.status)?.[1] ?? f.status },
  ].filter(Boolean) as { key: Key; label: string }[];
  const filtered = chips.length > 0;
  const total = data.data?.total ?? 0;

  return (
    <>
      <PageHeader title="Unibox"
        sub={view === "replies" ? "Replies to your campaigns from every connected mailbox — with the campaign and step each one answered" : "Every email that went out — which campaign, step and mailbox sent it, and what the lead did"}
        actions={<>
          <Seg value={view} onChange={(v) => go({ view: v })} options={[{ value: "replies", label: "Replies" }, { value: "sent", label: "Sent" }]} />
          <button className="btn btn-ghost" onClick={() => setFiltersOpen(true)}><Funnel /> Filters{filtered && <span className="badge b-pink ml-1">{chips.length}</span>}</button>
        </>} />
      {filtered && (
        <div className="flex items-center gap-1.5 flex-wrap in" style={{ marginTop: -6 }}>
          {chips.map((c) => (
            <button key={c.key} className="badge b-pink" onClick={() => go({ [c.key]: "" })} title="Remove filter">{c.label} <X /></button>
          ))}
          <button className="text-muted ml-1" style={{ fontSize: 12 }} onClick={() => router.replace(view === "sent" ? `${pathname}?view=sent` : pathname)}>Clear all</button>
        </div>
      )}
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)" }}>
        <article className="card" style={{ padding: 8, alignSelf: "start", maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
          {view === "sent" && (
            <div className="ask mb-2" style={{ height: 36 }}><Search /><input placeholder="Search recipient, subject, company" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); setSelId(null); }} /></div>
          )}
          {data.isLoading ? <Skeleton h={200} /> : !items.length ? (
            <Empty icon={view === "replies" ? <Inbox /> : <Send />} title={filtered || q ? `No ${view === "replies" ? "replies" : "sent emails"} match these filters` : view === "replies" ? "No replies yet" : "Nothing sent yet"}>
              {filtered ? <button className="btn btn-sm btn-dark mt-2" onClick={() => router.replace(view === "sent" ? `${pathname}?view=sent` : pathname)}>Clear filters</button>
                : view === "replies" ? "Replies are detected over IMAP every couple of minutes and show up here." : "Emails sent by campaigns and one-off emails show up here."}
            </Empty>
          ) : <>
            <div className="text-[11.5px] text-muted px-2 pt-1 pb-2">{num(total)} {view === "replies" ? (total === 1 ? "reply" : "replies") : `email${total === 1 ? "" : "s"} sent`}</div>
            {items.map((it) => (
              <button key={it.id} onClick={() => setSelId(it.id)} className="w-full text-left tile mb-1.5" style={{ padding: "11px 13px", boxShadow: sel?.id === it.id ? "inset 0 0 0 1px var(--pink)" : undefined }}>
                <div className="flex justify-between gap-2"><b className="font-medium text-[13.5px] truncate-1">{it.name || it.to}</b><small className="text-[11px] text-muted flex-none">{ago(view === "replies" ? (it as ReplyItem).replied_at : it.sent_at)}</small></div>
                <div className="flex items-center gap-1.5 mt-1 min-w-0">
                  <span className="text-[11.5px] text-pink truncate-1 min-w-0">{it.campaign ?? (view === "replies" ? "Direct email" : "One-off email")}</span>
                  {it.stage && <span className="badge b-gray flex-none" style={{ fontSize: 10.5 }}>{stageLabel(it.stage, it.campaign_kind)}</span>}
                </div>
                <div className="text-[12px] text-txt-2 truncate-1 mt-0.5">{it.subject}</div>
                {view === "replies"
                  ? <div className="text-[11.5px] text-muted truncate-1 mt-0.5">{((it as ReplyItem).reply ?? "").slice(0, 120)}</div>
                  : <div className="flex items-center justify-between gap-2 mt-1"><span className="text-[11px] text-muted truncate-1">{it.mailbox ?? ""}</span><Engagement m={it as SentItem} /></div>}
              </button>
            ))}
            {total > SIZE && (
              <div className="flex justify-between items-center gap-2 px-2 py-1.5 text-[12px] text-txt-2">
                Page {page} of {Math.ceil(total / SIZE)}
                <span className="flex gap-1.5">
                  <button className="btn btn-sm btn-dark" disabled={page === 1} onClick={() => { setPage(page - 1); setSelId(null); }}>Prev</button>
                  <button className="btn btn-sm btn-dark" disabled={page * SIZE >= total} onClick={() => { setPage(page + 1); setSelId(null); }}>Next</button>
                </span>
              </div>
            )}
          </>}
        </article>
        <article className="card" style={{ minHeight: 420, minWidth: 0 }}>
          {!sel ? <Empty icon={view === "replies" ? <Reply /> : <Send />} title={view === "replies" ? "Select a conversation" : "Select an email"} />
            : view === "replies" ? <ReplyPane key={sel.id} sel={sel as ReplyItem} /> : <SentPane key={sel.id} item={sel as SentItem} />}
        </article>
      </div>
      {filtersOpen && <FiltersOverlay open onClose={() => setFiltersOpen(false)} view={view} value={f} mailboxes={mbs.data ?? []} onApply={(next) => go(next)} />}
    </>
  );
}
