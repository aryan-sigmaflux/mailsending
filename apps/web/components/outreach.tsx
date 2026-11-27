"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Eye, History, Layers, Mail, Megaphone, MousePointerClick, Reply, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { Empty, Modal, Skeleton, Spinner, StatusBadge } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago, num, stageLabel } from "@/lib/format";
import type { Contact, DncEntry, OutreachHistory, Stage } from "@/lib/types";

const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function DncBadge({ dnc }: { dnc: DncEntry }) {
  const byDomain = dnc.entry.startsWith("@");
  return (
    <span className="badge b-red" title={`${dnc.label}${byDomain ? ` — whole domain ${dnc.entry}` : ""}${dnc.note ? ` · ${dnc.note}` : ""}`}>
      <Ban /> {dnc.reason === "manual" ? "Do not contact" : dnc.label}{byDomain ? " (domain)" : ""}
    </span>
  );
}

export function ContactedBadge({ h }: { h: OutreachHistory }) {
  const where = [...h.campaigns.map((c) => c.name), ...(h.direct ? ["one-off email"] : [])].join(", ");
  return (
    <span className="badge b-blue" title={`${h.sent} email${h.sent === 1 ? "" : "s"} sent · last ${fullDate(h.last_sent_at)}\n${where}`}>
      <History /> Contacted{h.sent > 1 ? ` ×${h.sent}` : ""}
    </span>
  );
}

/** "Do not contact" and "Contacted ×N" flags for a lead — nothing when neither applies. */
export function OutreachBadges({ c }: { c: Pick<Contact, "dnc" | "history"> }) {
  if (!c.dnc && !c.history) return null;
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {c.dnc && <DncBadge dnc={c.dnc} />}
      {c.history && <ContactedBadge h={c.history} />}
    </span>
  );
}

interface HistoryMessage {
  id: string; subject: string; status: string; error: string | null; sent_at: string; mailbox: string | null;
  campaign: string | null; campaign_id: string | null; campaign_kind: string | null; stage: Stage | null; template: string | null;
  opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number;
  clicks: { url: string; at: string }[]; replied_at: string | null; reply: string | null;
}

/** Everything sent to one lead (campaign, step, mailbox) and what they did — plus the do-not-contact switch. */
export function ContactHistoryModal({ contactId, onClose }: { contactId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["contact-history", contactId], enabled: !!contactId,
    queryFn: () => get<{ contact: Contact; messages: HistoryMessage[] }>(`/contacts/${contactId}/history`),
  });
  const c = q.data?.contact;
  const refresh = () => ["contact-history", "contacts", "contacts-summary", "suppressions"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const block = useMutation({ mutationFn: () => post("/suppressions", { emails: [c!.email] }), onSuccess: () => { toast.ok(`${c!.email} won't be contacted`); refresh(); }, onError: toast.err });
  const unblock = useMutation({ mutationFn: () => del(`/suppressions/${encodeURIComponent(c!.dnc!.entry)}`), onSuccess: () => { toast.ok("Removed from do-not-contact"); refresh(); }, onError: toast.err });
  if (!contactId) return null;
  const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
  const h = c?.history;

  return (
    <Modal open onClose={onClose} wide title={c?.email ?? "Contact"} sub={c ? [name, c.title, c.company].filter(Boolean).join(" · ") || "No name on file" : ""}>
      {q.isLoading || !c ? <Skeleton h={220} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            {c.dnc ? <DncBadge dnc={c.dnc} /> : <span className="badge b-green"><ShieldCheck /> OK to contact</span>}
            {h ? <ContactedBadge h={h} /> : <span className="badge b-gray">Never contacted</span>}
            <span className="flex-1" />
            {c.dnc ? (
              <button className="btn btn-sm btn-dark" disabled={unblock.isPending} onClick={() => unblock.mutate()}
                title={c.dnc.entry.startsWith("@") ? `Removes the whole-domain entry ${c.dnc.entry}` : undefined}>
                {unblock.isPending ? <Spinner size={14} /> : <>Allow contact{c.dnc.entry.startsWith("@") ? ` (unblock ${c.dnc.entry})` : ""}</>}
              </button>
            ) : (
              <button className="btn btn-sm btn-danger" disabled={block.isPending} onClick={() => block.mutate()}>{block.isPending ? <Spinner size={14} /> : <><Ban /> Do not contact</>}</button>
            )}
          </div>
          {c.dnc?.note && <p className="text-[12.5px] text-txt-2 -mt-2">Note: {c.dnc.note}</p>}

          {h && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              {([["Sent", h.sent, ""], ["Opened", h.opened, ""], ["Clicked", h.clicked, "text-pink"], ["Replied", h.replied, "text-green"]] as const).map(([l, v, cls]) => (
                <div key={l} className="tile"><div className={`text-[20px] font-medium ${cls}`}>{num(v)}</div><div className="text-[11.5px] text-muted">{l}</div></div>
              ))}
            </div>
          )}

          {!q.data!.messages.length ? <Empty icon={<Mail />} title="Nothing sent to this lead yet" /> : (
            <div className="flex flex-col gap-2" style={{ maxHeight: 440, overflowY: "auto" }}>
              {q.data!.messages.map((m) => (
                <div key={m.id} className="tile" style={{ padding: "12px 14px" }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {m.campaign_id ? (
                      <Link href={`/campaigns/${m.campaign_id}/analytics`} className="badge b-pink"><Megaphone /> {m.campaign}</Link>
                    ) : <span className="badge b-gray"><Megaphone /> One-off email</span>}
                    {m.stage && <span className="badge b-gray"><Layers /> {stageLabel(m.stage, m.campaign_kind)}</span>}
                    {m.status !== "sent" && <StatusBadge status={m.status} />}
                    <span className="flex-1" />
                    <small className="text-[11.5px] text-muted" title={fullDate(m.sent_at)}>{fullDate(m.sent_at)}</small>
                  </div>
                  <div className="text-[13.5px] mt-1.5 truncate-1">{m.subject || <span className="text-faint">(no subject)</span>}</div>
                  <div className="text-[11.5px] text-muted mt-0.5">from {m.mailbox ?? "a deleted mailbox"}{m.template ? ` · template “${m.template}”` : ""}</div>
                  {m.error && m.status !== "sent" && <div className="text-[11.5px] text-red mt-1 truncate-1" title={m.error}>{m.error}</div>}
                  <div className="flex gap-3 flex-wrap mt-2 text-[12px]">
                    <span className={m.opened_at ? "text-txt" : "text-faint"}><Eye width={13} className="inline -mt-0.5" /> {m.opened_at ? `Opened ${m.open_count > 1 ? `${m.open_count}× · ` : ""}${ago(m.opened_at)}` : "Not opened"}</span>
                    <span className={m.clicks.length ? "text-pink" : "text-faint"}><MousePointerClick width={13} className="inline -mt-0.5" /> {m.clicks.length ? `${m.clicks.length} click${m.clicks.length > 1 ? "s" : ""}` : "No clicks"}</span>
                    <span className={m.replied_at ? "text-green" : "text-faint"}><Reply width={13} className="inline -mt-0.5" /> {m.replied_at ? `Replied ${ago(m.replied_at)}` : "No reply"}</span>
                  </div>
                  {m.clicks.length > 0 && (
                    <ul className="mt-1.5 text-[11.5px] text-txt-2 flex flex-col gap-0.5">
                      {m.clicks.map((k, i) => <li key={i} className="truncate-1"><a className="link" href={k.url} target="_blank" rel="noreferrer">{k.url}</a> · {ago(k.at)}</li>)}
                    </ul>
                  )}
                  {m.reply?.trim() && <pre className="whitespace-pre-wrap font-sans text-[12.5px] text-txt-2 mt-2 pl-3" style={{ borderLeft: "2px solid var(--green)" }}>{m.reply.slice(0, 600)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
