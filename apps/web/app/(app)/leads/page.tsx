"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, MailCheck, Plus, ScanSearch, Search, Trash, Upload, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Field, Modal, PageHeader, Skeleton, Spinner, VerifyBadge, confirmAction } from "@/components/ui";
import { BASE_URL, del, get, post, tokens } from "@/lib/api";
import { num } from "@/lib/format";
import type { Contact, ContactList, Paged, ResearchSummary } from "@/lib/types";

const TARGETS = [
  ["email", "Email"], ["first_name", "First name"], ["last_name", "Last name"], ["company", "Company"], ["title", "Job title"],
  ["phone", "Phone"], ["website", "Website"], ["linkedin_url", "LinkedIn URL"], ["city", "City"], ["country", "Country"],
];

function ImportModal({ list, onClose }: { list: ContactList | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<{ name: string; suggested: string; sample: string[] }[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);

  async function pick(f: File) {
    setFile(f);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await post<{ headers: typeof headers }>(`/lists/${list!.id}/preview-headers`, fd);
      setHeaders(r.headers);
      setMap(Object.fromEntries(r.headers.map((h) => [h.name, h.suggested])));
    } catch (e) { toast.err(e); }
  }

  async function run() {
    if (!file || !list) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mapping", JSON.stringify(map));
    try {
      const r = await post<Record<string, number>>(`/lists/${list.id}/import`, fd);
      setResult(r);
      qc.invalidateQueries({ queryKey: ["lists"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e) { toast.err(e); }
    setBusy(false);
  }

  if (!list) return null;
  const standard = new Set(TARGETS.map(([k]) => k));
  return (
    <Modal open onClose={onClose} wide title={`Import CSV into “${list.name}”`} sub="Every column becomes a template variable — e.g. a “Industry” column is available as {{Industry}}.">
      {result ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {[["Imported", result.imported, "text-green"], ["Updated", result.updated, ""], ["Invalid emails", result.invalid, "text-red"], ["Duplicates", result.duplicates, ""], ["Suppressed", result.suppressed, "text-amber"], ["Over limit", result.over_limit, "text-red"]].map(([l, v, c]) => (
            <div key={l as string} className="tile"><div className={`text-[22px] font-medium ${c}`}>{num(v as number)}</div><div className="text-[12px] text-muted">{l}</div></div>
          ))}
          <div className="col-span-3 flex justify-end"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
        </div>
      ) : !headers.length ? (
        <label className="tile flex flex-col items-center justify-center text-center cursor-pointer" style={{ padding: 40, borderStyle: "dashed" }}>
          <FileUp width={30} height={30} className="text-pink mb-3" />
          <b className="font-medium">Choose a CSV file</b>
          <span className="text-[12.5px] text-muted mt-1">Comma, semicolon or tab separated · up to 20 MB · first row = headers</span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        </label>
      ) : (
        <>
          <div className="overflow-x-auto" style={{ maxHeight: 380 }}>
            <table className="table">
              <thead><tr><th>CSV column</th><th>Sample</th><th>Maps to</th></tr></thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h.name}>
                    <td>{h.name}</td>
                    <td className="text-[12px] text-muted max-w-[200px] truncate-1">{h.sample.filter(Boolean).slice(0, 2).join(", ")}</td>
                    <td style={{ width: 240 }}>
                      <select className="select" value={standard.has(map[h.name]) ? map[h.name] : map[h.name] ? "__custom" : ""} onChange={(e) => setMap({ ...map, [h.name]: e.target.value === "__custom" ? h.name : e.target.value })}>
                        <option value="">— Skip —</option>
                        {TARGETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        <option value="__custom">Custom variable {`{{${h.name}}}`}</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center mt-5">
            <span className="text-[12.5px] text-muted">{file?.name}</span>
            <div className="flex gap-2">
              <button className="btn btn-dark" onClick={() => setHeaders([])}>Back</button>
              <button className="btn btn-primary" disabled={busy || !Object.values(map).includes("email")} onClick={run}>
                {busy ? <><Spinner /> Importing…</> : <><Upload /> Import</>}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function LeadsPage() {
  const qc = useQueryClient();
  const [picked, setActive] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [newList, setNewList] = useState(false);
  const [listName, setListName] = useState("");
  const [importing, setImporting] = useState<ContactList | null>(null);

  const lists = useQuery({ queryKey: ["lists"], queryFn: () => get<ContactList[]>("/lists") });
  const active = lists.data?.some((l) => l.id === picked) ? picked : (lists.data?.[0]?.id ?? null);
  const contacts = useQuery({
    queryKey: ["contacts", active, q, page],
    queryFn: () => get<Paged<Contact>>(`/contacts?${new URLSearchParams({ ...(active ? { list_id: active } : {}), q, page: String(page), size: "50" })}`),
    enabled: !!active,
  });
  const current = lists.data?.find((l) => l.id === active) ?? null;
  const domains = useMemo(() => [...new Set((contacts.data?.items ?? []).map((c) => c.research_domain).filter(Boolean) as string[])].sort(), [contacts.data]);
  const research = useQuery({
    queryKey: ["research-sum", domains.join(",")], enabled: domains.length > 0,
    queryFn: () => get<Record<string, ResearchSummary>>(`/research/by-domain?domains=${encodeURIComponent(domains.join(","))}`),
  });

  const create = useMutation({ mutationFn: () => post<ContactList>("/lists", { name: listName }), onSuccess: (l) => { setNewList(false); setListName(""); setActive(l.id); qc.invalidateQueries({ queryKey: ["lists"] }); setImporting(l); }, onError: toast.err });
  const removeList = useMutation({ mutationFn: (id: string) => del(`/lists/${id}`), onSuccess: () => { setActive(null); qc.invalidateQueries({ queryKey: ["lists"] }); }, onError: toast.err });
  const removeContact = useMutation({ mutationFn: (id: string) => del(`/contacts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }), onError: toast.err });
  const verify = useMutation({ mutationFn: (id: string) => post<{ queued: number; skipped_no_credits: number }>("/verify/bulk", { list_id: id }), onSuccess: (r) => toast.ok(`Verifying ${r.queued} emails in the background${r.skipped_no_credits ? ` (${r.skipped_no_credits} skipped — no credits)` : ""}`), onError: toast.err });

  return (
    <>
      <PageHeader title="Lead lists" sub="Upload CSVs, enrich from Apollo, and verify before you send"
        actions={<button className="btn btn-primary" onClick={() => setNewList(true)}><Plus /> New list</button>} />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)" }}>
        <aside className="card" style={{ padding: 10, alignSelf: "start" }}>
          {lists.isLoading ? <Skeleton h={120} /> : !lists.data?.length ? (
            <Empty icon={<Users />} title="No lists yet" />
          ) : (
            <nav className="nav">
              {lists.data.map((l) => (
                <a key={l.id} href="#" onClick={(e) => { e.preventDefault(); setActive(l.id); setPage(1); }} className={l.id === active ? "on" : ""}>
                  <Users /><span className="truncate-1 flex-1">{l.name}</span><span className="count" style={{ display: "inline" }}>{num(l.contact_count)}</span>
                </a>
              ))}
            </nav>
          )}
        </aside>

        <article className="card" style={{ minWidth: 0 }}>
          {!current ? (
            <Empty icon={<Users />} title="Create a lead list" action={<button className="btn btn-primary" onClick={() => setNewList(true)}><Plus /> New list</button>}>
              Lists hold the leads you send campaigns to. Import from CSV now or from Apollo via the Lead Finder.
            </Empty>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <h3>{current.name}</h3>
                  <p className="card-sub">{num(current.contact_count)} contacts{current.columns.length ? ` · custom variables: ${current.columns.map((c) => `{{${c}}}`).join(" ")}` : ""}</p>
                </div>
                <div className="ask" style={{ height: 38, width: 240 }}><Search /><input placeholder="Search contacts" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
                <button className="btn btn-sm btn-ghost" onClick={() => setImporting(current)}><Upload /> Import CSV</button>
                <button className="btn btn-sm btn-ghost" onClick={() => verify.mutate(current.id)} disabled={verify.isPending}><MailCheck /> Verify list</button>
                <Link className="btn btn-sm btn-ghost" href="/leads/research"><ScanSearch /> Research</Link>
                <a className="btn btn-sm btn-dark" href="#" onClick={async (e) => {
                  e.preventDefault();
                  const res = await fetch(`${BASE_URL}/contacts?list_id=${current.id}&size=500`, { headers: { Authorization: `Bearer ${tokens.access()}` } });
                  const data: Paged<Contact> = await res.json();
                  const cols = ["email", "first_name", "last_name", "company", "title", "verify_status", ...current.columns];
                  const csv = [cols.join(","), ...data.items.map((c) => cols.map((k) => JSON.stringify((c as unknown as Record<string, string>)[k] ?? c.fields[k] ?? "")).join(","))].join("\n");
                  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `${current.name}.csv`; a.click();
                }}>Export</a>
                <button className="btn btn-icon btn-sm btn-danger" title="Delete list" onClick={() => confirmAction(`Delete “${current.name}”? Contacts stay in your account.`) && removeList.mutate(current.id)}><Trash /></button>
              </div>
              <div className="overflow-x-auto mt-4">
                {contacts.isLoading ? <Skeleton h={200} /> : !contacts.data?.items.length ? (
                  <Empty icon={<FileUp />} title={q ? "No matches" : "This list is empty"} action={!q && <button className="btn btn-primary" onClick={() => setImporting(current)}><Upload /> Import CSV</button>} />
                ) : (
                  <table className="table">
                    <thead><tr><th>Email</th><th>Name</th><th>Company</th><th>Title</th><th>Status</th><th title="Website research score">Website</th>{current.columns.slice(0, 3).map((c) => <th key={c}>{c}</th>)}<th /></tr></thead>
                    <tbody>
                      {contacts.data.items.map((c) => (
                        <tr key={c.id}>
                          <td className="truncate-1 max-w-[240px]">{c.email}{c.unsubscribed && <span className="badge b-amber ml-2">unsub</span>}</td>
                          <td>{[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="text-faint">—</span>}</td>
                          <td className="truncate-1 max-w-[180px]">{c.company || <span className="text-faint">—</span>}</td>
                          <td className="truncate-1 max-w-[160px] text-txt-2">{c.title}</td>
                          <td><VerifyBadge status={c.verify_status} /></td>
                          <td>{(() => {
                            const r = c.research_domain ? research.data?.[c.research_domain] : undefined;
                            if (!r) return <span className="text-faint">—</span>;
                            if (r.status !== "done") return <span className="badge b-gray">{r.status === "running" ? "researching" : r.status}</span>;
                            return <span className={`badge ${r.score == null ? "b-gray" : r.score >= 80 ? "b-green" : r.score >= 50 ? "b-amber" : "b-red"}`} title={`${r.issue_count} issues · ${r.domain}`}>{r.score}/100 · {r.issue_count} issues</span>;
                          })()}</td>
                          {current.columns.slice(0, 3).map((k) => <td key={k} className="text-txt-2 truncate-1 max-w-[140px]">{c.fields[k] ?? ""}</td>)}
                          <td><button className="btn btn-icon btn-sm btn-dark" title="Delete contact" onClick={() => removeContact.mutate(c.id)}><Trash /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {(contacts.data?.total ?? 0) > 50 && (
                <div className="flex justify-end items-center gap-2 mt-4 text-[12.5px] text-txt-2">
                  Page {page} of {Math.ceil(contacts.data!.total / 50)}
                  <button className="btn btn-sm btn-dark" disabled={page === 1} onClick={() => setPage(page - 1)}>Prev</button>
                  <button className="btn btn-sm btn-dark" disabled={page * 50 >= contacts.data!.total} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </article>
      </div>

      <Modal open={newList} onClose={() => setNewList(false)} title="New lead list" footer={<><button className="btn btn-dark" onClick={() => setNewList(false)}>Cancel</button><button className="btn btn-primary" disabled={!listName || create.isPending} onClick={() => create.mutate()}>Create & import</button></>}>
        <Field label="List name"><input className="input" autoFocus value={listName} onChange={(e) => setListName(e.target.value)} placeholder="Manufacturers · India · Q4" onKeyDown={(e) => e.key === "Enter" && listName && create.mutate()} /></Field>
      </Modal>
      <ImportModal key={importing?.id ?? "none"} list={importing} onClose={() => setImporting(null)} />
    </>
  );
}
