"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, Plus, RefreshCw, Search, Trash } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Empty, PageHeader, Skeleton, Spinner, StatusBadge, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago } from "@/lib/format";
import type { CheckItem, Domain, DomainCheck } from "@/lib/types";

const CHECKS: { key: keyof DomainCheck; label: string; fix: string }[] = [
  { key: "mx", label: "MX", fix: "Add MX records from your mail provider so the domain can receive replies." },
  { key: "spf", label: "SPF", fix: 'Publish one TXT record like "v=spf1 include:_spf.google.com ~all" (use your provider\'s include).' },
  { key: "dkim", label: "DKIM", fix: "Enable DKIM signing in your mail provider and publish the TXT record it gives you." },
  { key: "dmarc", label: "DMARC", fix: 'Add a TXT record at _dmarc with "v=DMARC1; p=none; rua=mailto:you@domain" and move to quarantine later.' },
  { key: "blacklists", label: "Blacklists", fix: "Request delisting from each listed blacklist and pause sending until resolved." },
];

function ScoreRing({ score }: { score: number | null }) {
  const s = score ?? 0;
  const color = s >= 85 ? "var(--green)" : s >= 60 ? "var(--amber)" : "var(--red)";
  return (
    <div className="relative" style={{ width: 64, height: 64 }}>
      <svg viewBox="0 0 36 36" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray="97.4" strokeDashoffset={97.4 * (1 - s / 100)} style={{ transition: "stroke-dashoffset 1s var(--ease)" }} />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[14px] font-medium">{score ?? "—"}</span>
    </div>
  );
}

function CheckGrid({ check }: { check: DomainCheck }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      {CHECKS.map(({ key, label, fix }) => {
        const c = check[key] as CheckItem;
        if (!c) return null;
        return (
          <div key={key} className="tile">
            <div className="flex items-center justify-between"><b className="font-medium text-[13.5px]">{label}</b><StatusBadge status={c.status} /></div>
            <p className="text-[12px] text-txt-2 mt-2">{c.message}</p>
            {typeof c.record === "string" && <code className="block text-[11px] text-muted mt-2 break-all">{c.record}</code>}
            {c.records && <div className="text-[11px] text-muted mt-2">{c.records.map((r) => `${r.priority} ${r.host}`).join(" · ")}</div>}
            {c.listed && c.listed.length > 0 && <div className="text-[11px] text-red mt-2">{c.listed.map((l) => l.list).join(", ")}</div>}
            {c.status !== "pass" && <p className="text-[11.5px] text-pink mt-2">Fix: {fix}</p>}
          </div>
        );
      })}
    </div>
  );
}

export default function DomainsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [lookup, setLookup] = useState("");
  const q = useQuery({ queryKey: ["domains"], queryFn: () => get<Domain[]>("/domains") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["domains"] });

  const add = useMutation({ mutationFn: () => post<Domain>("/domains", { name }), onSuccess: (d) => { toast.ok(`${d.name} added — score ${d.health_score}`); setName(""); setOpen(d.id); refresh(); }, onError: toast.err });
  const recheck = useMutation({ mutationFn: (id: string) => post<Domain>(`/domains/${id}/check`), onSuccess: refresh, onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/domains/${id}`), onSuccess: refresh, onError: toast.err });
  const adhoc = useMutation({ mutationFn: () => get<DomainCheck>(`/domains/lookup?domain=${encodeURIComponent(lookup)}`), onError: toast.err });

  return (
    <>
      <PageHeader title="Domains" sub="Check SPF, DKIM, DMARC, MX and blacklist status for your sending domains" />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", ["--d" as string]: 1 }}>
        <form className="card flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <label className="field flex-1"><span>Add a sending domain</span><input className="input" placeholder="yourdomain.com" value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <button className="btn btn-primary" disabled={add.isPending}>{add.isPending ? <><Spinner /> Checking…</> : <><Plus /> Add</>}</button>
        </form>
        <form className="card flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); adhoc.mutate(); }}>
          <label className="field flex-1"><span>Quick check any domain (not saved)</span><input className="input" placeholder="prospect.com" value={lookup} onChange={(e) => setLookup(e.target.value)} required /></label>
          <button className="btn btn-ghost" disabled={adhoc.isPending}>{adhoc.isPending ? <Spinner /> : <><Search /> Check</>}</button>
        </form>
      </div>

      {adhoc.data && (
        <article className="card in">
          <div className="flex items-center gap-4 mb-4"><ScoreRing score={adhoc.data.score} /><div><h3>{adhoc.data.domain}</h3><p className="card-sub">Quick check result</p></div></div>
          <CheckGrid check={adhoc.data} />
        </article>
      )}

      {q.isLoading ? <Skeleton h={120} /> : !q.data?.length ? (
        <article className="card"><Empty icon={<Globe />} title="No domains yet">Add the domains your mailboxes send from. We&apos;ll re-check them and flag problems before they hurt deliverability.</Empty></article>
      ) : (
        q.data.map((d, i) => (
          <article key={d.id} className="card hoverable in" style={{ ["--d" as string]: i + 2 }}>
            <div className="flex items-center gap-4 flex-wrap">
              <ScoreRing score={d.health_score} />
              <button className="text-left flex-1 min-w-[200px]" onClick={() => setOpen(open === d.id ? null : d.id)}>
                <h3 className="flex items-center gap-2">{d.name} {d.verified ? <StatusBadge status="pass" label="verified" /> : <StatusBadge status="warn" label="unverified" />}</h3>
                <p className="card-sub">{d.mailbox_count} mailbox{d.mailbox_count === 1 ? "" : "es"} · checked {ago(d.checked_at)}</p>
              </button>
              <div className="flex gap-1.5 flex-wrap">
                {d.last_check && CHECKS.map(({ key, label }) => <StatusBadge key={key} status={(d.last_check![key] as CheckItem).status} label={label} />)}
              </div>
              <div className="flex gap-1.5">
                <button className="btn btn-icon btn-sm btn-dark" title="Re-check" onClick={() => recheck.mutate(d.id)} disabled={recheck.isPending && recheck.variables === d.id}>
                  {recheck.isPending && recheck.variables === d.id ? <Spinner size={14} /> : <RefreshCw />}
                </button>
                <button className="btn btn-icon btn-sm btn-danger" title="Remove" onClick={() => confirmAction(`Remove ${d.name}?`) && remove.mutate(d.id)}><Trash /></button>
              </div>
            </div>
            {open === d.id && d.last_check && (
              <div className="mt-5 flex flex-col gap-4">
                {!d.verified && (
                  <div className="tile flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <b className="font-medium text-[13px]">Verify ownership</b>
                      <p className="text-[12px] text-txt-2">Add this TXT record on <b>{d.name}</b>, then re-check:</p>
                      <code className="text-[12px] text-pink break-all">sigmaflux-verify={d.verify_token}</code>
                    </div>
                    <button className="btn btn-sm btn-ghost" onClick={() => { navigator.clipboard.writeText(`sigmaflux-verify=${d.verify_token}`); toast.ok("Copied"); }}><Copy /> Copy</button>
                  </div>
                )}
                <CheckGrid check={d.last_check} />
              </div>
            )}
          </article>
        ))
      )}
    </>
  );
}
