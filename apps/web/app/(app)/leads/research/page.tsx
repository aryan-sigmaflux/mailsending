"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, ChartLine, CircleCheck, CircleExclamationPoint, Copy, ExternalLink, Gauge, Globe, RefreshCw, ScanSearch, Search, Square, Trash, Upload, Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Meter, Modal, PageHeader, Skeleton, Spinner, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago, num } from "@/lib/format";
import type { Contact, ContactList, Integration, Paged, Research, ResearchStatus, ResearchSummary, Severity } from "@/lib/types";

const PAGE = 50;
const SEV: Record<Severity, string> = { high: "b-red", medium: "b-amber", low: "b-gray" };
const STATUS: Record<ResearchStatus, [string, string]> = {
  queued: ["b-gray", "Queued"], running: ["b-pink", "Researching"], done: ["b-green", "Done"], failed: ["b-red", "Failed"], cancelled: ["b-gray", "Cancelled"],
};
const FILTERS = [["", "All leads"], ["none", "Not researched"], ["pending", "In progress"], ["done", "Researched"], ["failed", "Failed"]] as const;

const scoreTone = (s: number | null | undefined) => (s == null ? "b-gray" : s >= 80 ? "b-green" : s >= 50 ? "b-amber" : "b-red");
const money = (n: number | null | undefined, cur?: string) => (n == null ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ""}`);

function ScoreBadge({ score }: { score: number | null | undefined }) {
  return <span className={`badge ${scoreTone(score)}`} title="Website score: 100 = no issues found">{score == null ? "—" : `${score}/100`}</span>;
}

function topKeyword(r?: ResearchSummary) {
  const kws = r?.keywords ?? [];
  return kws.filter((k) => k.volume != null).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0] ?? kws[0];
}

function Sources({ integrations }: { integrations?: Integration[] }) {
  const has = (k: Integration["kind"]) => integrations?.some((i) => i.kind === k);
  const items: [boolean | undefined, React.ReactNode, string, string][] = [
    [true, <Globe key="g" />, "Website audit", "Always on — 35 checks: titles, meta, H1s, HTTPS, broken links, sitemap, mobile…"],
    [has("ai"), <Bot key="b" />, "AI keywords", has("ai") ? "Your AI provider picks 5 product/service keywords" : "Not connected — keywords come from page headings (less accurate)"],
    [has("keywords"), <ChartLine key="c" />, "Volume & bids", has("keywords") ? "Search volume, competition and top-of-page bids" : "Not connected — keywords get no volume or bids"],
    [has("pagespeed"), <Gauge key="p" />, "PageSpeed", has("pagespeed") ? "Mobile performance score available (tick it below)" : "Optional — works without a key at low volume"],
  ];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
      {items.map(([ok, icon, title, sub]) => (
        <div key={title} className="tile flex gap-3 items-start" style={{ padding: "12px 14px" }}>
          <span className={ok ? "text-green" : "text-amber"} style={{ width: 18, flex: "none" }}>{icon}</span>
          <div className="min-w-0">
            <b className="font-normal text-[13.5px] flex items-center gap-2">{title}{ok ? <CircleCheck width={14} className="text-green" /> : <CircleExclamationPoint width={14} className="text-amber" />}</b>
            <small className="block text-[11.5px] text-muted">{sub}</small>
          </div>
        </div>
      ))}
      {(!has("ai") || !has("keywords")) && <p className="text-[12px] text-muted col-span-full">Connect sources in <Link href="/settings" className="text-pink">Settings</Link>. Research already done keeps its data; re-run it after connecting.</p>}
    </div>
  );
}

type PlannerImport = { export_keywords: number; matched_keywords: number; unmatched_keywords: number; sites_updated: number; leads_enriched: number; currency: string; period: string };

/** Manual Keyword Planner round trip: copy every keyword as one line → paste in Planner → import its CSV export. */
function PlannerCard({ list }: { list: ContactList }) {
  const qc = useQueryClient();
  const [missingOnly, setMissingOnly] = useState(false);
  const [result, setResult] = useState<PlannerImport | null>(null);
  const kws = useQuery({
    queryKey: ["planner-keywords", list.id, missingOnly],
    queryFn: () => get<{ sites: number; count: number; lines: string[] }>(`/research/planner-keywords?list_id=${list.id}&missing_only=${missingOnly}`),
  });
  const upload = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("file", file); fd.append("list_id", list.id); return post<PlannerImport>("/research/planner-import", fd); },
    onSuccess: (r) => {
      setResult(r);
      if (r.matched_keywords) toast.ok(`Keyword Planner data added to ${r.sites_updated} website${r.sites_updated === 1 ? "" : "s"} · ${r.leads_enriched} leads updated`);
      else toast.err("None of the keywords in that file match this list's researched keywords");
      ["planner-keywords", "research-sum", "research-contacts", "research"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: toast.err,
  });
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.ok("Keywords copied — paste them into Keyword Planner"); } catch { toast.err("Couldn't copy — select the text and copy it manually"); }
  }
  const lines = kws.data?.lines ?? [];

  return (
    <article className="card">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <h3 className="flex items-center gap-2"><ChartLine width={18} /> Keyword Planner — volumes &amp; bids</h3>
          <p className="card-sub">No API needed: copy the keywords of “{list.name}”, get their numbers in Google Keyword Planner, then import the file it downloads.</p>
        </div>
        <label className="check text-[12.5px]"><input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />Only keywords without volume yet</label>
      </div>

      <ol className="grid gap-3 mt-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <li className="tile" style={{ padding: "12px 14px" }}>
          <b className="font-normal text-[13.5px]">1 · Copy the keywords</b>
          {kws.isLoading ? <Skeleton h={60} className="mt-2" /> : !lines.length ? (
            <p className="text-[12.5px] text-muted mt-2">{missingOnly ? "Every keyword already has volume data." : "No researched keywords in this list yet — research some leads first."}</p>
          ) : (
            <>
              <small className="block text-[11.5px] text-muted mt-1">{num(kws.data!.count)} unique keywords from {num(kws.data!.sites)} websites{lines.length > 1 ? ` — split into ${lines.length} pastes (Planner takes 10,000 at a time)` : ""}</small>
              {lines.map((l, i) => (
                <div key={i} className="mt-2">
                  <textarea className="textarea" readOnly rows={3} value={l} onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} aria-label={`Keywords ${i + 1}`} />
                  <button className="btn btn-sm btn-primary mt-1.5" onClick={() => copy(l)}><Copy /> Copy{lines.length > 1 ? ` part ${i + 1}` : ""}</button>
                </div>
              ))}
            </>
          )}
        </li>
        <li className="tile text-[12.5px] text-txt-2" style={{ padding: "12px 14px" }}>
          <b className="font-normal text-[13.5px] text-txt">2 · Get the numbers in Google</b>
          <ol className="list-decimal pl-4 mt-1.5 flex flex-col gap-1">
            <li>Open <a className="text-pink" href="https://ads.google.com/aw/keywordplanner/home" target="_blank" rel="noreferrer">Keyword Planner</a> → <b>Get search volume and forecasts</b></li>
            <li>Paste the line, pick location &amp; language → <b>Get started</b></li>
            <li>On <b>Historical metrics</b> click <b>Download</b> → <b>.csv</b></li>
          </ol>
        </li>
        <li className="tile" style={{ padding: "12px 14px" }}>
          <b className="font-normal text-[13.5px]">3 · Import the downloaded file</b>
          <small className="block text-[11.5px] text-muted mt-1">The “Keyword Stats … .csv” file, as downloaded (a re-saved CSV works too).</small>
          <label className="btn btn-sm btn-ghost mt-2" style={{ cursor: upload.isPending ? "wait" : "pointer" }}>
            {upload.isPending ? <Spinner /> : <Upload />} Choose file
            <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className="hidden" disabled={upload.isPending}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload.mutate(f); }} />
          </label>
          {result && (
            <p className="text-[12px] text-txt-2 mt-2">
              {num(result.matched_keywords)} of {num(result.export_keywords)} keywords in the file matched · {num(result.sites_updated)} websites and {num(result.leads_enriched)} leads updated
              {result.currency ? ` · bids in ${result.currency}` : ""}{result.period ? ` · ${result.period}` : ""}
              {result.unmatched_keywords > 0 && <span className="text-amber"> · {num(result.unmatched_keywords)} researched keyword{result.unmatched_keywords === 1 ? " wasn't" : "s weren't"} in the file</span>}
            </p>
          )}
        </li>
      </ol>
    </article>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["research", id], queryFn: () => get<Research>(`/research/${id}`),
    refetchInterval: (query) => (["queued", "running"].includes(query.state.data?.status ?? "") ? 3000 : false),
  });
  const r = q.data;
  const remove = useMutation({
    mutationFn: () => del(`/research/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["research-sum"] }); qc.invalidateQueries({ queryKey: ["research-contacts"] }); onClose(); },
    onError: toast.err,
  });
  const f = (r?.facts ?? {}) as Record<string, unknown>;
  const groups = (["high", "medium", "low"] as Severity[]).map((s) => [s, (r?.issues ?? []).filter((i) => i.severity === s)] as const);
  const broken = (f.broken_links as { url: string; status: string | number }[] | undefined) ?? [];
  const ps = r?.facts.pagespeed;
  const cur = r?.keywords.find((k) => k.currency)?.currency;

  return (
    <Modal open onClose={onClose} wide title={r ? r.domain : "Research"} sub={r?.summary || (r?.final_url ?? r?.url)}>
      {!r ? <Skeleton h={300} /> : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`badge ${STATUS[r.status][0]}`}>{STATUS[r.status][1]}</span>
            <ScoreBadge score={r.score} />
            <span className="badge b-gray">{r.issues.length} issue{r.issues.length === 1 ? "" : "s"}</span>
            {r.researched_at && <small className="text-muted">researched {ago(r.researched_at)}</small>}
            <span className="flex-1" />
            <a className="btn btn-sm btn-dark" href={r.final_url ?? r.url} target="_blank" rel="noreferrer"><ExternalLink /> Open site</a>
            <button className="btn btn-sm btn-danger" onClick={() => confirmAction(`Delete the research for ${r.domain}? Lead fields it filled stay as they are.`) && remove.mutate()}><Trash /> Delete</button>
          </div>
          {r.error && <p className="badge b-red" style={{ whiteSpace: "normal", padding: "7px 10px" }}>{r.error}</p>}

          <section>
            <h3 className="mb-2">Keywords</h3>
            {r.metrics_error && <p className="badge b-amber mb-2" style={{ whiteSpace: "normal", padding: "7px 10px" }}>{r.metrics_error}</p>}
            {!r.keywords.length ? <p className="text-[13px] text-muted">No keywords — the site had no readable text.</p> : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Keyword</th><th>Monthly searches</th><th>Competition</th><th>Top-of-page bid</th><th>Avg CPC</th></tr></thead>
                  <tbody>
                    {r.keywords.map((k) => (
                      <tr key={k.keyword}>
                        <td>{k.keyword}</td>
                        <td>{k.volume == null ? <span className="text-faint">—</span> : k.no_data ? <span className="text-muted" title="Keyword Planner had too few searches to report">no data (≈0)</span> : k.volume_range ? <span title="Ranged volume — Keyword Planner shows ranges for accounts without ad spend; the low end is used for conditions">{k.volume_range}</span> : num(k.volume)}{k.yoy_change && <small className="block text-[11px] text-muted">YoY {k.yoy_change}</small>}</td>
                        <td>{k.competition ? <span className={`badge ${k.competition === "HIGH" ? "b-red" : k.competition === "MEDIUM" ? "b-amber" : "b-green"}`}>{k.competition.toLowerCase()}{k.competition_index != null ? ` · ${k.competition_index}` : ""}</span> : <span className="text-faint">—</span>}</td>
                        <td>{k.low_bid == null && k.high_bid == null ? <span className="text-faint">—</span> : `${money(k.low_bid)} – ${money(k.high_bid, k.currency)}`}</td>
                        <td>{money(k.cpc, k.cpc != null ? k.currency : undefined)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <small className="text-[11.5px] text-muted">
              Keywords from {r.keyword_source === "ai" ? "your AI provider" : r.keyword_source === "heuristic" ? "page headings (connect an AI provider for better ones)" : "—"}
              {r.metrics_source ? ` · numbers from ${({ google_ads: "Google Ads Keyword Planner", dataforseo: "DataForSEO", keyword_planner_csv: "your Keyword Planner export" } as Record<string, string>)[r.metrics_source] ?? r.metrics_source}` : ""}
              {r.options.location_code ? ` · location ${r.options.location_code}` : ""}{cur ? ` · bids in ${cur}` : ""}
            </small>
          </section>

          <section>
            <h3 className="mb-2">What&apos;s broken</h3>
            {!r.issues.length ? <p className="text-[13px] text-green">Nothing found — this site is in good shape.</p> : groups.map(([s, list]) => list.length > 0 && (
              <div key={s} className="mb-3">
                <div className="nav-label" style={{ padding: "0 0 6px" }}>{s} priority · {list.length}</div>
                <ul className="flex flex-col gap-1.5">
                  {list.map((i) => (
                    <li key={i.code} className="tile flex items-start gap-3" style={{ padding: "8px 12px" }}>
                      <span className={`badge ${SEV[i.severity]} flex-none mt-0.5`}>{i.category}</span>
                      <div className="min-w-0"><b className="font-normal text-[13.5px]">{i.title}</b>{i.detail && <small className="block text-[12px] text-muted break-words">{i.detail}</small>}</div>
                      <code className="ml-auto text-[11px] text-faint flex-none" title="Use this code in sequence conditions">{i.code}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {[
              ["Title", (f.title as string) || "—"],
              ["Meta description", (f.meta_description as string) || "—"],
              ["H1 headings", ((f.h1 as string[]) ?? []).join(" · ") || "—"],
              ["Response", f.status ? `HTTP ${f.status} · ${num(f.load_ms as number)} ms · ${num(Math.round(((f.html_bytes as number) ?? 0) / 1024))} KB` : "—"],
              ["Words on homepage", f.word_count != null ? num(f.word_count as number) : "—"],
              ["Images without alt", f.images != null ? `${f.images_missing_alt} of ${f.images}` : "—"],
              ["Links checked", f.links_checked != null ? `${f.links_checked} · ${broken.length} broken` : "—"],
              ["PageSpeed (mobile)", ps?.score != null ? `${ps.score}/100${ps.lcp_ms ? ` · LCP ${(ps.lcp_ms / 1000).toFixed(1)}s` : ""}` : ps?.error ? `failed: ${ps.error}` : "not run"],
            ].map(([k, v]) => (
              <div key={k} className="tile" style={{ padding: "9px 12px" }}><small className="block text-[11.5px] text-muted">{k}</small><span className="text-[13px] break-words">{v}</span></div>
            ))}
          </section>
          {broken.length > 0 && (
            <section>
              <h3 className="mb-2">Broken links</h3>
              <ul className="text-[12.5px] flex flex-col gap-1">{broken.map((b) => <li key={b.url} className="break-all"><span className="badge b-red mr-2">{b.status}</span>{b.url}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function ResearchPage() {
  const qc = useQueryClient();
  const [picked, setList] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState({ rerun: false, pagespeed: false, use_email_domain: true, use_lead_country: true });
  const [open, setOpen] = useState<string | null>(null);

  const lists = useQuery({ queryKey: ["lists"], queryFn: () => get<ContactList[]>("/lists") });
  const integ = useQuery({ queryKey: ["integrations"], queryFn: () => get<Integration[]>("/integrations") });
  const active = lists.data?.some((l) => l.id === picked) ? picked : (lists.data?.[0]?.id ?? null);
  const current = lists.data?.find((l) => l.id === active) ?? null;

  const status = useQuery({
    queryKey: ["research-status"], queryFn: () => get<Partial<Record<ResearchStatus | "batch_finished", number>>>("/research/status"),
    refetchInterval: (query) => ((query.state.data?.queued ?? 0) + (query.state.data?.running ?? 0) > 0 ? 3000 : false),
  });
  const busy = (status.data?.queued ?? 0) + (status.data?.running ?? 0) > 0;

  const contacts = useQuery({
    queryKey: ["research-contacts", active, q, filter, page],
    queryFn: () => get<Paged<Contact>>(`/contacts?${new URLSearchParams({ list_id: active!, q, research: filter, page: String(page), size: String(PAGE) })}`),
    enabled: !!active,
    refetchInterval: busy ? 4000 : false,
  });
  const domains = useMemo(() => [...new Set((contacts.data?.items ?? []).map((c) => c.research_domain).filter(Boolean) as string[])].sort(), [contacts.data]);
  const sums = useQuery({
    queryKey: ["research-sum", domains.join(",")], queryFn: () => get<Record<string, ResearchSummary>>(`/research/by-domain?domains=${encodeURIComponent(domains.join(","))}`),
    enabled: domains.length > 0, refetchInterval: busy ? 3000 : false,
  });

  const start = useMutation({
    mutationFn: (body: object) => post<{ leads: number; queued: number; already_done: number; in_progress: number; no_website: number }>("/research", { ...opts, ...body }),
    onSuccess: (r) => {
      const bits = [`${r.queued} website${r.queued === 1 ? "" : "s"} queued`];
      if (r.already_done) bits.push(`${r.already_done} already researched (tick “Re-run” to refresh)`);
      if (r.in_progress) bits.push(`${r.in_progress} already in progress`);
      if (r.no_website) bits.push(`${r.no_website} lead${r.no_website === 1 ? "" : "s"} skipped — no website or company email`);
      (r.queued ? toast.ok : toast.info)(bits.join(" · "));
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ["research-status"] });
      qc.invalidateQueries({ queryKey: ["research-contacts"] });
      qc.invalidateQueries({ queryKey: ["research-sum"] });
    },
    onError: toast.err,
  });
  const cancel = useMutation({ mutationFn: () => post<{ cancelled: number }>("/research/cancel"), onSuccess: (r) => { toast.info(`Cancelled ${r.cancelled} queued website${r.cancelled === 1 ? "" : "s"}`); qc.invalidateQueries({ queryKey: ["research-status"] }); qc.invalidateQueries({ queryKey: ["research-sum"] }); }, onError: toast.err });

  const items = contacts.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((c) => sel.has(c.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const st = status.data ?? {};
  const batchDone = st.batch_finished ?? 0;

  return (
    <>
      <PageHeader title="Research leads" sub="Audit each lead's website, find the 5 keywords they sell on, get search volume and bids — then branch your sequences on what you found." />
      <div className="flex flex-col gap-4 in">
        <article className="card">
          <Sources integrations={integ.data} />
          {busy && (
            <div className="mt-4">
              <div className="flex items-center gap-3 text-[12.5px] mb-1.5">
                <Spinner size={14} /><span className="text-txt-2">Researching {num(st.running ?? 0)} · {num(st.queued ?? 0)} waiting · {num(batchDone)} finished in this batch</span>
                <span className="flex-1" />
                <button className="btn btn-sm btn-dark" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Square /> Cancel queued</button>
              </div>
              <Meter value={batchDone} max={batchDone + (st.queued ?? 0) + (st.running ?? 0)} />
            </div>
          )}
        </article>

        <article className="card" style={{ minWidth: 0 }}>
          {lists.isLoading ? <Skeleton h={200} /> : !lists.data?.length ? (
            <Empty icon={<Users />} title="No lead lists yet" action={<Link className="btn btn-primary" href="/leads">Go to Lead lists</Link>}>Import leads with a Website column first — research audits that website.</Empty>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <select className="select" style={{ width: 240 }} value={active ?? ""} onChange={(e) => { setList(e.target.value); setPage(1); setSel(new Set()); }} aria-label="Lead list">
                  {lists.data.map((l) => <option key={l.id} value={l.id}>{l.name} ({num(l.contact_count)})</option>)}
                </select>
                <select className="select" style={{ width: 170 }} value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(1); }} aria-label="Filter">
                  {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <div className="ask" style={{ height: 38, width: 220 }}><Search /><input placeholder="Search leads" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
                <span className="flex-1" />
                <button className="btn btn-sm btn-ghost" disabled={start.isPending || !current} onClick={() => current && confirmAction(`Research every lead in “${current.name}” (${num(current.contact_count)} leads)? Leads on the same domain share one audit.`) && start.mutate({ list_id: current.id, all_in_list: true })}>
                  <ScanSearch /> Research whole list
                </button>
                <button className="btn btn-sm btn-primary" disabled={start.isPending || sel.size === 0} onClick={() => start.mutate({ contact_ids: [...sel] })}>
                  {start.isPending ? <Spinner /> : <ScanSearch />} Research {sel.size || ""} selected
                </button>
              </div>
              <div className="flex gap-x-5 gap-y-2 flex-wrap mt-3 text-[12.5px]">
                {([
                  ["rerun", "Re-run sites already researched"],
                  ["pagespeed", "Include PageSpeed test (slower)"],
                  ["use_email_domain", "No website? Use the email's domain"],
                  ["use_lead_country", "Keyword volume for the lead's country"],
                ] as const).map(([k, l]) => (
                  <label key={k} className="check text-[12.5px]"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />{l}</label>
                ))}
              </div>

              <div className="overflow-x-auto mt-4">
                {contacts.isLoading ? <Skeleton h={200} /> : !items.length ? (
                  <Empty icon={<ScanSearch />} title={q || filter ? "No matching leads" : "This list is empty"} />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 34 }}><label className="check" title="Select all on this page"><input type="checkbox" checked={allOnPage} onChange={(e) => setSel((s) => { const n = new Set(s); items.forEach((c) => (e.target.checked ? n.add(c.id) : n.delete(c.id))); return n; })} /></label></th>
                        <th>Lead</th><th>Website</th><th>Research</th><th>Score</th><th>Issues</th><th>Top keyword</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((c) => {
                        const r = c.research_domain ? sums.data?.[c.research_domain] : undefined;
                        const top = topKeyword(r);
                        const site = c.website || (c.research_domain ? `(email) ${c.research_domain}` : "");
                        return (
                          <tr key={c.id} style={sel.has(c.id) ? { background: "rgba(238,178,220,.05)" } : undefined}>
                            <td><label className="check"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.email}`} /></label></td>
                            <td className="max-w-[220px]"><span className="block truncate-1">{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}</span><small className="block text-muted truncate-1">{c.company || c.email}</small></td>
                            <td className="truncate-1 max-w-[200px] text-txt-2">{site || <span className="text-faint">no website</span>}</td>
                            <td>{r ? <span className={`badge ${STATUS[r.status][0]}`} title={r.error ?? ""}>{r.status === "running" && <Spinner size={10} />}{STATUS[r.status][1]}</span> : <span className="text-faint">—</span>}</td>
                            <td>{r?.status === "done" ? <ScoreBadge score={r.score} /> : <span className="text-faint">—</span>}</td>
                            <td>{r?.status === "done" ? r.issue_count : <span className="text-faint">—</span>}</td>
                            <td className="max-w-[220px]">{top ? <><span className="block truncate-1">{top.keyword}</span><small className="text-muted">{top.volume != null ? `${num(top.volume)}/mo` : "no volume data"}{top.high_bid != null ? ` · bid ${money(top.high_bid, top.currency)}` : ""}</small></> : <span className="text-faint">—</span>}</td>
                            <td>{r && <button className="btn btn-sm btn-dark" onClick={() => setOpen(r.id)}>View</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex justify-between items-center gap-2 mt-4 text-[12.5px] text-txt-2 flex-wrap">
                <span>{sel.size ? `${sel.size} selected` : ""}{sel.size > 0 && <button className="link ml-2 text-pink" onClick={() => setSel(new Set())}>clear</button>}</span>
                {(contacts.data?.total ?? 0) > PAGE && (
                  <span className="flex items-center gap-2">
                    Page {page} of {Math.ceil(contacts.data!.total / PAGE)}
                    <button className="btn btn-sm btn-dark" disabled={page === 1} onClick={() => setPage(page - 1)}>Prev</button>
                    <button className="btn btn-sm btn-dark" disabled={page * PAGE >= contacts.data!.total} onClick={() => setPage(page + 1)}>Next</button>
                  </span>
                )}
                <button className="btn btn-sm btn-dark" onClick={() => { contacts.refetch(); sums.refetch(); status.refetch(); }}><RefreshCw /> Refresh</button>
              </div>
            </>
          )}
        </article>

        {current && <PlannerCard key={current.id} list={current} />}

        <p className="text-[12px] text-muted">
          Results are added to each lead as variables — <code className="text-pink">{"{{SiteScore}}"}</code>, <code className="text-pink">{"{{TopIssue}}"}</code>, <code className="text-pink">{"{{TopKeyword}}"}</code>, <code className="text-pink">{"{{TopKeywordVolume}}"}</code>, <code className="text-pink">{"{{Keyword1}}"}</code>… — and Condition steps in <Link href="/sequences" className="text-pink">Sequences</Link> can branch on any issue or number.
        </p>
      </div>
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
