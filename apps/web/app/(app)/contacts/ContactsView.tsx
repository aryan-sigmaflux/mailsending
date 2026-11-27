"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Contact as ContactIcon, Eye, FileUp, Globe, History, MousePointerClick, Plus, Reply, Search, Trash } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ContactHistoryModal, OutreachBadges } from "@/components/outreach";
import { toast } from "@/components/toast";
import { Empty, Field, PageHeader, Seg, Skeleton, Spinner, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago, num } from "@/lib/format";
import type { Contact, Paged } from "@/lib/types";

interface Summary { total: number; contacted: number; never_contacted: number; dnc: number; dnc_entries: number }
interface DncRow { email: string; is_domain: boolean; reason: string; label: string; note: string; created_at: string }

const SIZE = 50;

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  if (total <= SIZE) return null;
  return (
    <div className="flex justify-end items-center gap-2 mt-4 text-[12.5px] text-txt-2">
      Page {page} of {Math.ceil(total / SIZE)}
      <button className="btn btn-sm btn-dark" disabled={page === 1} onClick={() => onPage(page - 1)}>Prev</button>
      <button className="btn btn-sm btn-dark" disabled={page * SIZE >= total} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

type Show = "all" | "contacted" | "never" | "dnc";
const SHOW_QS: Record<Show, Record<string, string>> = { all: {}, contacted: { contacted: "yes" }, never: { contacted: "no" }, dnc: { dnc: "yes" } };

function AllContacts({ summary }: { summary?: Summary }) {
  const [show, setShow] = useState<Show>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["contacts", "all", show, q, page],
    queryFn: () => get<Paged<Contact>>(`/contacts?${new URLSearchParams({ q, page: String(page), size: String(SIZE), ...SHOW_QS[show] })}`),
  });
  const s = summary;
  const opts: { value: Show; label: string }[] = [
    { value: "all", label: `All${s ? ` · ${num(s.total)}` : ""}` },
    { value: "contacted", label: `Contacted${s ? ` · ${num(s.contacted)}` : ""}` },
    { value: "never", label: `Never contacted${s ? ` · ${num(s.never_contacted)}` : ""}` },
    { value: "dnc", label: `Do not contact${s ? ` · ${num(s.dnc)}` : ""}` },
  ];

  return (
    <article className="card in" style={{ minWidth: 0 }}>
      <div className="flex items-center gap-3 flex-wrap">
        <Seg value={show} options={opts} onChange={(v) => { setShow(v); setPage(1); }} />
        <span className="flex-1" />
        <div className="ask" style={{ height: 38, width: 260 }}><Search /><input placeholder="Search email, name, company" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
      </div>
      <div className="overflow-x-auto mt-4">
        {list.isLoading ? <Skeleton h={220} /> : !list.data?.items.length ? (
          <Empty icon={<ContactIcon />} title={q || show !== "all" ? "No contacts match" : "No contacts yet"}>
            {!q && show === "all" && "Import a lead list — every address you store and every email you send is tracked here."}
          </Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Status</th><th>Last contacted</th><th>Campaigns</th><th title="Opened · clicked · replied">Engagement</th><th /></tr></thead>
            <tbody>
              {list.data.items.map((c) => {
                const h = c.history;
                return (
                  <tr key={c.id} className="cursor-pointer" onClick={() => setOpen(c.id)}>
                    <td className="truncate-1 max-w-[240px]">{c.email}</td>
                    <td>{[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="text-faint">—</span>}</td>
                    <td className="truncate-1 max-w-[170px]">{c.company || <span className="text-faint">—</span>}</td>
                    <td>{c.dnc || h ? <OutreachBadges c={c} /> : <span className="badge b-gray">Never contacted</span>}</td>
                    <td className="text-txt-2 whitespace-nowrap" title={h ? new Date(h.last_sent_at).toLocaleString() : undefined}>{h ? ago(h.last_sent_at) : <span className="text-faint">—</span>}</td>
                    <td className="text-txt-2 truncate-1 max-w-[200px]" title={h?.campaigns.map((x) => x.name).join(", ")}>
                      {h ? [...h.campaigns.map((x) => x.name), ...(h.direct ? ["One-off"] : [])].join(", ") : <span className="text-faint">—</span>}
                    </td>
                    <td className="whitespace-nowrap text-[12px]">
                      {h ? <span className="inline-flex gap-2.5 text-txt-2">
                        <span title="Emails opened" className={h.opened ? "" : "text-faint"}><Eye width={13} className="inline -mt-0.5" /> {h.opened}</span>
                        <span title="Emails with a link clicked" className={h.clicked ? "text-pink" : "text-faint"}><MousePointerClick width={13} className="inline -mt-0.5" /> {h.clicked}</span>
                        <span title="Replies" className={h.replied ? "text-green" : "text-faint"}><Reply width={13} className="inline -mt-0.5" /> {h.replied}</span>
                      </span> : <span className="text-faint">—</span>}
                    </td>
                    <td><button className="btn btn-icon btn-sm btn-dark" title="Outreach history" onClick={(e) => { e.stopPropagation(); setOpen(c.id); }}><History /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Pager page={page} total={list.data?.total ?? 0} onPage={setPage} />
      <ContactHistoryModal contactId={open} onClose={() => setOpen(null)} />
    </article>
  );
}

type Reason = "" | "manual" | "unsubscribed" | "bounced" | "complained";

function DoNotContact() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<Reason>("");
  const [kind, setKind] = useState<"" | "email" | "domain">("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["suppressions", reason, kind, q, page],
    queryFn: () => get<Paged<DncRow> & { counts: Record<string, number> }>(`/suppressions?${new URLSearchParams({ reason, kind, q, page: String(page), size: String(SIZE) })}`),
  });
  const refresh = () => ["suppressions", "contacts", "contacts-summary", "contact-history"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const entries = text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const add = useMutation({
    mutationFn: () => post<{ added: number; already_listed: number; invalid: string[] }>("/suppressions", { emails: entries, note }),
    onSuccess: (r) => {
      toast.ok(`${num(r.added)} added${r.already_listed ? ` · ${num(r.already_listed)} already listed` : ""}${r.invalid.length ? ` · ${r.invalid.length} not valid (${r.invalid.slice(0, 3).join(", ")}${r.invalid.length > 3 ? "…" : ""})` : ""}`);
      if (!r.invalid.length) setText("");
      else setText(r.invalid.join("\n"));
      refresh();
    },
    onError: toast.err,
  });
  const remove = useMutation({ mutationFn: (e: string) => del(`/suppressions/${encodeURIComponent(e)}`), onSuccess: refresh, onError: toast.err });

  const counts = list.data?.counts ?? {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const reasons: { value: Reason; label: string }[] = [
    { value: "", label: `All · ${num(all)}` },
    { value: "manual", label: `Added by you · ${num(counts.manual ?? 0)}` },
    { value: "unsubscribed", label: `Unsubscribed · ${num(counts.unsubscribed ?? 0)}` },
    { value: "bounced", label: `Bounced · ${num(counts.bounced ?? 0)}` },
    ...(counts.complained ? [{ value: "complained" as Reason, label: `Complained · ${num(counts.complained)}` }] : []),
  ];

  return (
    <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)" }}>
      <article className="card" style={{ alignSelf: "start" }}>
        <h3>Add to do-not-contact</h3>
        <p className="card-sub">Addresses or whole domains. Campaigns and one-off emails will never send to them, and lead imports flag them.</p>
        <Field label="Emails or domains" className="mt-4" hint={<>One per line or comma-separated. <code>acme.com</code> or <code>@acme.com</code> blocks the whole domain.</>}>
          <textarea className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ceo@acme.com\ncompetitor.io"} />
        </Field>
        <Field label="Note (optional)" className="mt-3"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Existing client, asked not to be contacted…" maxLength={500} /></Field>
        <div className="flex items-center gap-2 mt-4">
          <label className="btn btn-sm btn-ghost cursor-pointer"><FileUp /> From CSV
            <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const found = (await f.text()).match(/[^\s,;"'<>]+@[^\s,;"'<>]+\.[a-z]{2,}/gi) ?? [];
              setText([...new Set(found.map((x) => x.toLowerCase()))].join("\n"));
              if (!found.length) toast.err(new Error("No email addresses found in that file"));
              e.target.value = "";
            }} />
          </label>
          <span className="flex-1" />
          <button className="btn btn-primary" disabled={!entries.length || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? <Spinner /> : <><Plus /> Add {entries.length > 1 ? num(entries.length) : ""}</>}
          </button>
        </div>
      </article>

      <article className="card" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-3 flex-wrap">
          <Seg value={reason} options={reasons} onChange={(v) => { setReason(v); setPage(1); }} />
          <span className="flex-1" />
          <select className="select" style={{ width: 200 }} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setPage(1); }} aria-label="Entry type">
            <option value="">Addresses & domains</option><option value="email">Addresses only</option><option value="domain">Domains only</option>
          </select>
          <div className="ask" style={{ height: 38, width: 220 }}><Search /><input placeholder="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        </div>
        <div className="overflow-x-auto mt-4">
          {list.isLoading ? <Skeleton h={200} /> : !list.data?.items.length ? (
            <Empty icon={<Ban />} title={q || reason || kind ? "Nothing matches" : "The do-not-contact list is empty"}>
              {!q && !reason && !kind && "Unsubscribes and bounces are added automatically. Add anyone else you must never email."}
            </Empty>
          ) : (
            <table className="table">
              <thead><tr><th>Address / domain</th><th>Reason</th><th>Note</th><th>Added</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.email}>
                    <td className="truncate-1 max-w-[280px]">{r.is_domain ? <span className="inline-flex items-center gap-1.5"><Globe width={14} className="text-amber" /> Everyone at <b className="font-medium">{r.email.slice(1)}</b></span> : r.email}</td>
                    <td><span className={`badge ${r.reason === "manual" ? "b-red" : r.reason === "bounced" ? "b-amber" : "b-gray"}`}>{r.label}</span></td>
                    <td className="text-txt-2 truncate-1 max-w-[260px]" title={r.note}>{r.note || <span className="text-faint">—</span>}</td>
                    <td className="text-txt-2 whitespace-nowrap" title={new Date(r.created_at).toLocaleString()}>{ago(r.created_at)}</td>
                    <td>
                      <button className="btn btn-icon btn-sm btn-dark" title="Remove — allow contacting again"
                        onClick={() => confirmAction(`Allow contacting ${r.is_domain ? `everyone at ${r.email.slice(1)}` : r.email} again?${r.reason !== "manual" ? `\n\nThey were added because: ${r.label.toLowerCase()}.` : ""}`) && remove.mutate(r.email)}>
                        <Trash />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Pager page={page} total={list.data?.total ?? 0} onPage={setPage} />
      </article>
    </div>
  );
}

export default function ContactsView() {
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") === "dnc" ? "dnc" : "all";
  const summary = useQuery({ queryKey: ["contacts-summary"], queryFn: () => get<Summary>("/contacts/summary") });
  const s = summary.data;

  return (
    <>
      <PageHeader title="Contacts" sub="Every lead you store — who has already been emailed, from which campaign and mailbox, and who must never be contacted"
        actions={<Seg value={tab} onChange={(v) => router.replace(v === "dnc" ? `${pathname}?tab=dnc` : pathname, { scroll: false })} options={[
          { value: "all", label: `All contacts${s ? ` · ${num(s.total)}` : ""}` },
          { value: "dnc", label: `Do not contact${s ? ` · ${num(s.dnc_entries)}` : ""}` },
        ]} />} />
      {tab === "dnc" ? <DoNotContact /> : <AllContacts summary={s} />}
    </>
  );
}
