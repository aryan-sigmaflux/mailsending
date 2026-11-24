"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ChartColumn, Inbox, Layers, Megaphone, Reply, Send } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Empty, PageHeader, Skeleton, Spinner } from "@/components/ui";
import { get, post } from "@/lib/api";
import { ago, stageLabel } from "@/lib/format";
import type { Mailbox, Paged, Stage } from "@/lib/types";

interface Item {
  id: string; to: string; name: string; company: string | null; mailbox: string | null;
  campaign: string | null; campaign_id: string | null; campaign_kind: string | null; stage: Stage | null; template: string | null;
  subject: string; reply: string | null; replied_at: string; sent_body: string; sent_at: string;
}
interface CampaignReplies { id: string | null; name: string; kind: string | null; replies: number; stages: (Stage & { replies: number })[] }

export default function InboxView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const mailbox = params.get("mailbox") ?? "";
  const campaign = params.get("campaign") ?? "";
  const stage = params.get("stage") ?? "";
  const [selId, setSelId] = useState<string | null>(null);
  const [text, setText] = useState("");

  /** Filters live in the URL so campaign analytics can link straight to "replies from this campaign / step". */
  function setFilter(next: Partial<Record<"mailbox" | "campaign" | "stage", string>>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if ("campaign" in next) p.delete("stage");
    setSelId(null);
    router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
  }

  const mbs = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });
  const camps = useQuery({ queryKey: ["inbox-campaigns", mailbox], queryFn: () => get<CampaignReplies[]>(`/inbox/campaigns${mailbox ? `?mailbox_id=${mailbox}` : ""}`), refetchInterval: 60_000 });
  const qs = new URLSearchParams({ size: "50", ...(mailbox && { mailbox_id: mailbox }), ...(campaign && { campaign_id: campaign }), ...(stage && { node_id: stage }) });
  const q = useQuery({ queryKey: ["inbox", mailbox, campaign, stage], queryFn: () => get<Paged<Item>>(`/inbox?${qs}`), refetchInterval: 60_000 });
  const sel = q.data?.items.find((i) => i.id === selId) ?? null;
  const reply = useMutation({
    mutationFn: () => post(`/inbox/${sel!.id}/reply`, { body_html: text.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;") || "&nbsp;"}</p>`).join("") }),
    onSuccess: () => { toast.ok(`Reply sent to ${sel!.to}`); setText(""); },
    onError: toast.err,
  });

  const campaignOptions = (camps.data ?? []).filter((c) => c.id);
  const current = campaignOptions.find((c) => c.id === campaign);
  // Selected campaign may have no replies in this mailbox (or yet) — keep it in the list so the filter still shows.
  const missingCurrent = campaign && camps.data && !current;
  const showStages = current && current.kind === "sequence" && current.stages.length > 0;

  return (
    <>
      <PageHeader title="Unibox" sub="Replies to your campaigns from every connected mailbox — with the campaign and step each one answered"
        actions={<>
          <select className="select" style={{ width: 230 }} value={campaign} onChange={(e) => setFilter({ campaign: e.target.value })} aria-label="Campaign">
            <option value="">All campaigns</option>
            {campaignOptions.map((c) => <option key={c.id} value={c.id!}>{c.name} ({c.replies})</option>)}
            {missingCurrent && <option value={campaign}>Selected campaign (0)</option>}
          </select>
          {showStages && (
            <select className="select" style={{ width: 210 }} value={stage} onChange={(e) => setFilter({ stage: e.target.value })} aria-label="Step">
              <option value="">All steps</option>
              {current.stages.map((s) => <option key={s.node_id ?? ""} value={s.node_id ?? ""}>{stageLabel(s, current.kind)} ({s.replies})</option>)}
            </select>
          )}
          <select className="select" style={{ width: 230 }} value={mailbox} onChange={(e) => setFilter({ mailbox: e.target.value })} aria-label="Mailbox">
            <option value="">All mailboxes</option>
            {mbs.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
          </select>
        </>} />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)" }}>
        <article className="card" style={{ padding: 8, alignSelf: "start", maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
          {q.isLoading ? <Skeleton h={200} /> : !q.data?.items.length ? (
            <Empty icon={<Inbox />} title={campaign || stage || mailbox ? "No replies match these filters" : "No replies yet"}>
              {campaign || stage || mailbox ? <button className="btn btn-sm btn-dark mt-2" onClick={() => router.replace(pathname)}>Show all replies</button> : "Replies are detected over IMAP every couple of minutes and show up here."}
            </Empty>
          ) : <>
            <div className="text-[11.5px] text-muted px-2 pt-1 pb-2">{q.data.total} {q.data.total === 1 ? "reply" : "replies"}</div>
            {q.data.items.map((it) => (
              <button key={it.id} onClick={() => setSelId(it.id)} className="w-full text-left tile mb-1.5" style={{ padding: "11px 13px", boxShadow: sel?.id === it.id ? "inset 0 0 0 1px var(--pink)" : undefined }}>
                <div className="flex justify-between gap-2"><b className="font-medium text-[13.5px] truncate-1">{it.name || it.to}</b><small className="text-[11px] text-muted flex-none">{ago(it.replied_at)}</small></div>
                <div className="flex items-center gap-1.5 mt-1 min-w-0">
                  <span className="text-[11.5px] text-pink truncate-1 min-w-0">{it.campaign ?? "Direct email"}</span>
                  {it.stage && <span className="badge b-gray flex-none" style={{ fontSize: 10.5 }}>{stageLabel(it.stage, it.campaign_kind)}</span>}
                </div>
                <div className="text-[12px] text-txt-2 truncate-1 mt-0.5">{it.subject}</div>
                <div className="text-[11.5px] text-muted truncate-1 mt-0.5">{(it.reply ?? "").slice(0, 120)}</div>
              </button>
            ))}
          </>}
        </article>
        <article className="card" style={{ minHeight: 420 }}>
          {!sel ? <Empty icon={<Reply />} title="Select a conversation" /> : (
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
                <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">{sel.reply}</pre>
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
          )}
        </article>
      </div>
    </>
  );
}
