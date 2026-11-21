"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Inbox, Reply, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Empty, PageHeader, Skeleton, Spinner } from "@/components/ui";
import { get, post } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Mailbox, Paged } from "@/lib/types";

interface Item { id: string; to: string; name: string; company: string | null; mailbox: string | null; campaign: string | null; subject: string; reply: string | null; replied_at: string; sent_body: string; sent_at: string }

export default function InboxPage() {
  const [mailbox, setMailbox] = useState("");
  const [sel, setSel] = useState<Item | null>(null);
  const [text, setText] = useState("");
  const mbs = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });
  const q = useQuery({ queryKey: ["inbox", mailbox], queryFn: () => get<Paged<Item>>(`/inbox?size=50${mailbox ? `&mailbox_id=${mailbox}` : ""}`), refetchInterval: 60_000 });
  const reply = useMutation({
    mutationFn: () => post(`/inbox/${sel!.id}/reply`, { body_html: text.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;") || "&nbsp;"}</p>`).join("") }),
    onSuccess: () => { toast.ok(`Reply sent to ${sel!.to}`); setText(""); },
    onError: toast.err,
  });

  return (
    <>
      <PageHeader title="Unibox" sub="Replies to your campaigns from every connected mailbox"
        actions={<select className="select" style={{ width: 260 }} value={mailbox} onChange={(e) => setMailbox(e.target.value)}><option value="">All mailboxes</option>{mbs.data?.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}</select>} />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)" }}>
        <article className="card" style={{ padding: 8, alignSelf: "start", maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
          {q.isLoading ? <Skeleton h={200} /> : !q.data?.items.length ? (
            <Empty icon={<Inbox />} title="No replies yet">Replies are detected over IMAP every couple of minutes and show up here.</Empty>
          ) : q.data.items.map((it) => (
            <button key={it.id} onClick={() => setSel(it)} className="w-full text-left tile mb-1.5" style={{ padding: "11px 13px", boxShadow: sel?.id === it.id ? "inset 0 0 0 1px var(--pink)" : undefined }}>
              <div className="flex justify-between gap-2"><b className="font-medium text-[13.5px] truncate-1">{it.name || it.to}</b><small className="text-[11px] text-muted flex-none">{ago(it.replied_at)}</small></div>
              <div className="text-[12px] text-txt-2 truncate-1">{it.subject}</div>
              <div className="text-[11.5px] text-muted truncate-1 mt-0.5">{(it.reply ?? "").slice(0, 120)}</div>
            </button>
          ))}
        </article>
        <article className="card" style={{ minHeight: 420 }}>
          {!sel ? <Empty icon={<Reply />} title="Select a conversation" /> : (
            <div className="flex flex-col gap-4 h-full">
              <div>
                <h3>{sel.subject}</h3>
                <p className="card-sub">{sel.name ? `${sel.name} · ` : ""}{sel.to}{sel.company ? ` · ${sel.company}` : ""} — via {sel.mailbox}{sel.campaign ? ` · ${sel.campaign}` : ""}</p>
              </div>
              <div className="tile" style={{ boxShadow: "inset 0 0 0 1px rgba(238,178,220,.35)" }}>
                <div className="text-[11.5px] text-pink mb-2">Their reply · {ago(sel.replied_at)}</div>
                <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">{sel.reply}</pre>
              </div>
              <details className="tile">
                <summary className="text-[12px] text-muted cursor-pointer">Your email · {ago(sel.sent_at)}</summary>
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
