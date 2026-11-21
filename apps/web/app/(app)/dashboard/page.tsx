"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CircleExclamationPoint, Flame, Globe, Mail, Plus, Search, ShieldCheck, TriangleExclamationPoint } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PerfChart, type Point } from "@/components/PerfChart";
import { Empty, ProviderBadge, Seg, Skeleton } from "@/components/ui";
import { get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { firstName, num, pct } from "@/lib/format";
import { useCountUp, useRotating } from "@/lib/hooks";
import type { Usage } from "@/lib/types";

interface DashMailbox { id: string; email: string; provider: string; status: string; health_score: number; warmup_enabled: boolean; warmup: { max_per_day: number }; daily_limit: number; sent_today: number; avg_last_week: number; last_error: string | null }
interface DashDomain { id: string; name: string; health_score: number | null; verified: boolean; mailboxes: number; issues: string[] }
interface Dash { usage: Usage; emails_sent_6m: number; rates_30d: { sent: number; opened: number; replied: number; bounced: number }; mailboxes: DashMailbox[]; domains: DashDomain[] }

const RANGES = ["1D", "1W", "1M", "6M", "1Y"] as const;
const ASK = ["Find manufacturers in India, 30+ employees", "Find HR heads at SaaS companies in Berlin", "Founders of fintech startups in Dubai"];

export default function Dashboard() {
  const router = useRouter();
  const me = useAuth((s) => s.me)!;
  const [range, setRange] = useState<(typeof RANGES)[number]>("1M");
  const [metric, setMetric] = useState<"sent" | "opened" | "replied">("sent");
  const [mbTab, setMbTab] = useState<"top" | "warm" | "issues">("top");
  const [ask, setAsk] = useState("");
  const placeholder = useRotating(ASK);

  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dash>("/dashboard"), refetchInterval: 30_000 });
  const perf = useQuery({ queryKey: ["perf", range], queryFn: () => get<{ points: Point[] }>(`/dashboard/performance?range=${range}`) });
  const sent = useCountUp(dash.data?.emails_sent_6m ?? 0);

  const mbs = dash.data?.mailboxes ?? [];
  const mbList = mbTab === "top" ? mbs.filter((m) => m.status === "active") : mbTab === "warm" ? mbs.filter((m) => m.warmup_enabled) : mbs.filter((m) => m.status !== "active" || m.last_error);
  const r = dash.data?.rates_30d;
  const u = me.usage;

  function submitAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!ask.trim()) return;
    sessionStorage.setItem("lead-finder-query", ask.trim());
    router.push("/lead-finder");
  }

  return (
    <>
      <header className="head in">
        <div>
          <h1>Welcome, <span className="accent">{firstName(me.user.full_name, me.user.email)}</span></h1>
          <p>Here&apos;s your outreach overview</p>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap in" style={{ ["--d" as string]: 1 }}>
        <Link href="/campaigns?new=1" className="btn btn-primary"><Plus /> New campaign</Link>
        <Link href="/mailboxes" className="btn btn-dark">Connect mailbox</Link>
        <Link href="/leads" className="btn btn-dark">Import leads</Link>
        <form onSubmit={submitAsk} className="ask ml-auto" style={{ width: "min(380px, 100%)" }}>
          <Search />
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={placeholder} aria-label="Ask the lead agent" />
          {ask && <button className="badge b-pink" type="submit">Enter ↵</button>}
        </form>
      </div>

      <section className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", ["--d" as string]: 2 }}>
        {/* Column 1: Emails sent + AI card */}
        <div className="flex flex-col gap-4">
          <article className="card glow" style={{ minHeight: 150 }}>
            <div className="flex items-center justify-between">
              <h3>Emails Sent</h3>
              <span className="chip" style={{ height: 30 }}><span>6M</span></span>
            </div>
            <div style={{ fontSize: 32, fontWeight: 500, marginTop: 20 }}>{dash.isLoading ? <Skeleton h={36} w={160} /> : num(sent)}</div>
            <div className="flex gap-4 mt-3 text-[12px] text-txt-2 flex-wrap">
              <span>Today <b className="font-medium text-txt">{num(u.emails_today)}</b> / {num(me.user.max_daily_emails)}</span>
              <span>Month <b className="font-medium text-txt">{num(u.emails_month)}</b> / {num(me.user.max_monthly_emails)}</span>
            </div>
          </article>
          <article className="card text-center flex flex-col items-center" style={{ minHeight: 200, padding: "24px 22px 0" }}>
            <h3>Leads Powered by AI</h3>
            <p className="text-[12.5px] leading-relaxed text-txt-2 font-light mt-3 max-w-[290px]">
              Describe your ideal customer — the agent searches Apollo, enriches and verifies every lead for you.
            </p>
            <div className="arc" />
            <Link href="/lead-finder" className="btn btn-primary relative" style={{ margin: "22px 0 20px" }}>Open Lead Agent</Link>
          </article>
        </div>

        {/* Column 2: Mailboxes */}
        <article className="card flex flex-col">
          <div className="flex items-center justify-between">
            <h3>Mailboxes</h3>
            <Link href="/mailboxes" className="btn btn-icon btn-ghost btn-sm" aria-label="All mailboxes"><ArrowUpRight /></Link>
          </div>
          <div className="mt-4 mb-1">
            <Seg value={mbTab} onChange={setMbTab} options={[{ value: "top", label: "Top Health" }, { value: "warm", label: "Warming" }, { value: "issues", label: "Issues" }]} />
          </div>
          {dash.isLoading ? (
            <div className="flex flex-col gap-3 mt-4">{[0, 1, 2].map((i) => <Skeleton key={i} h={40} />)}</div>
          ) : mbList.length === 0 ? (
            <Empty icon={<Mail />} title={mbTab === "issues" ? "No issues" : "No mailboxes here yet"}>
              {mbTab === "issues" ? "All connected mailboxes are healthy." : <Link className="text-pink" href="/mailboxes">Connect a mailbox</Link>}
            </Empty>
          ) : (
            <ul className="rowlist mt-1">
              {mbList.slice(0, 5).map((m, i) => (
                <li key={m.id} style={{ ["--d" as string]: i, animationDelay: `${i * 60}ms` }}>
                  <ProviderBadge provider={m.provider} />
                  <div className="min-w-0">
                    <b className="block font-normal text-[13.5px] truncate-1">{m.email}</b>
                    <small className="block text-[11px] text-muted truncate-1">
                      {mbTab === "issues" ? (m.last_error ?? m.status) : `${m.provider === "smtp" ? "SMTP" : m.provider === "google" ? "Google" : "Microsoft 365"} · Health ${m.health_score}`}
                    </small>
                  </div>
                  <div className="text-right text-[13.5px]">
                    {num(m.sent_today)}<span className="text-muted text-[11px]">/{m.daily_limit}</span>
                    <small className={`block text-[11px] ${m.sent_today >= m.avg_last_week ? "text-green" : "text-muted"}`}>
                      {m.avg_last_week ? `${m.sent_today >= m.avg_last_week ? "+" : ""}${pct(m.sent_today - m.avg_last_week, m.avg_last_week)}` : "today"}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        {/* Column 3: Domains */}
        <article className="card flex flex-col">
          <div className="flex items-center justify-between">
            <h3>Domains</h3>
            <div className="flex gap-1.5">
              <Link href="/domains" className="chip"><span>See all</span></Link>
              <Link href="/domains" className="btn btn-icon btn-ghost btn-sm" aria-label="Domains"><ArrowUpRight /></Link>
            </div>
          </div>
          {dash.isLoading ? (
            <div className="grid grid-cols-2 gap-3 mt-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={110} />)}</div>
          ) : !dash.data?.domains.length ? (
            <Empty icon={<Globe />} title="No domains yet" action={<Link href="/domains" className="btn btn-ghost btn-sm"><Plus /> Add domain</Link>}>
              Add your sending domains to check SPF, DKIM, DMARC and blacklists.
            </Empty>
          ) : (
            <div className="grid grid-cols-2 gap-3 mt-4 content-start">
              {dash.data.domains.slice(0, 4).map((d, i) => {
                const score = d.health_score ?? 0;
                return (
                  <Link href="/domains" key={d.id} className="tile hoverable flex flex-col" style={{ minHeight: 132, animation: `rowIn .5s var(--ease) ${200 + i * 80}ms backwards` }}>
                    <div className="text-[16px] font-medium">{d.health_score == null ? "—" : `${score}%`}</div>
                    <div className={`text-[11px] mt-0.5 ${d.issues.length ? "text-red" : "text-green"}`}>
                      {d.issues.length ? `${d.issues.length} issue${d.issues.length > 1 ? "s" : ""}: ${d.issues.join(", ").toUpperCase()}` : "All checks passing"}
                    </div>
                    <div className="mt-auto pt-4 text-muted">{d.issues.length ? <TriangleExclamationPoint width={20} /> : <ShieldCheck width={20} />}</div>
                    <div className="mt-2 text-[11.5px] text-txt-2 truncate-1">{d.name}</div>
                    <div className="text-[11px] text-muted">{d.mailboxes} mailbox{d.mailboxes === 1 ? "" : "es"}</div>
                  </Link>
                );
              })}
            </div>
          )}
        </article>
      </section>

      {/* Performance */}
      <article className="card in flex flex-col" style={{ ["--d" as string]: 3, minHeight: 360 }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3>Sending Performance</h3>
            {r && (
              <div className="flex gap-4 mt-1.5 text-[12px] text-txt-2 flex-wrap">
                <span>30d open rate <b className="text-txt font-medium">{pct(r.opened, r.sent)}</b></span>
                <span>Reply rate <b className="text-txt font-medium">{pct(r.replied, r.sent)}</b></span>
                <span>Bounce rate <b className={`font-medium ${r.sent && r.bounced / r.sent > 0.03 ? "text-red" : "text-txt"}`}>{pct(r.bounced, r.sent)}</b></span>
              </div>
            )}
          </div>
          <div className="flex gap-3 flex-wrap">
            <Seg value={metric} onChange={setMetric} options={[{ value: "sent", label: "Sent" }, { value: "opened", label: "Opened" }, { value: "replied", label: "Replied" }]} />
            <Seg value={range} onChange={setRange} options={RANGES.map((x) => ({ value: x, label: x }))} />
          </div>
        </div>
        <div className="mt-4 flex-1">
          {perf.data ? (
            perf.data.points.every((p) => p[metric] === 0) && !perf.isFetching ? (
              <div className="relative">
                <PerfChart points={perf.data.points} range={range} metric={metric} />
                <div className="absolute inset-0 grid place-items-center pointer-events-none">
                  <span className="badge b-gray" style={{ padding: "6px 12px" }}><Flame width={13} /> No emails {metric} in this period yet</span>
                </div>
              </div>
            ) : (
              <PerfChart points={perf.data.points} range={range} metric={metric} />
            )
          ) : perf.isError ? (
            <Empty icon={<CircleExclamationPoint />} title="Couldn't load performance" />
          ) : (
            <Skeleton h={250} />
          )}
        </div>
      </article>
    </>
  );
}
