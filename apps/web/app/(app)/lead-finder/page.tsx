"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, FileUp, Info, Search, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { get } from "@/lib/api";
import type { Integration } from "@/lib/types";

const TARGETS = ["CEO", "Founders", "HR", "Sales heads", "Marketing", "Engineering", "All employees"];

export default function LeadFinderPage() {
  const integ = useQuery({ queryKey: ["integrations"], queryFn: () => get<Integration[]>("/integrations") });
  const apollo = integ.data?.find((i) => i.kind === "apollo");
  const aiKey = integ.data?.find((i) => i.kind === "ai");
  const [query, setQuery] = useState(() => (typeof window === "undefined" ? "" : sessionStorage.getItem("lead-finder-query") ?? ""));
  useEffect(() => sessionStorage.removeItem("lead-finder-query"), []);

  return (
    <>
      <PageHeader title="Lead" accent="Finder" sub="Find and enrich leads from Apollo with AI — approve every credit spend before it happens" />
      <div className="card in flex gap-3 items-start flex-wrap" style={{ boxShadow: "inset 0 0 0 1px rgba(142,197,255,.35)" }}>
        <Info color="var(--blue)" width={18} className="flex-none mt-0.5" />
        <div className="text-[13px] text-txt-2 flex-1 min-w-[260px]">
          Connections: Apollo {apollo ? <span className="badge b-green">connected</span> : <span className="badge b-amber">not connected</span>} · AI {aiKey ? <span className="badge b-green">{aiKey.label}</span> : <span className="badge b-amber">not connected</span>}
          <p className="mt-2">The agentic search and document-to-leads pipelines are the next build phase. Connect your keys now in <Link href="/settings" className="text-pink">Settings</Link> so they&apos;re ready.</p>
        </div>
      </div>

      <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", ["--d" as string]: 1 }}>
        <article className="card flex flex-col" style={{ minHeight: 360 }}>
          <h3 className="flex items-center gap-2"><Bot width={18} /> Mode A · Ask the agent</h3>
          <p className="card-sub">Describe who you want. The agent turns it into an Apollo search, shows the filters and the credit cost, and only spends after you approve.</p>
          <div className="tile mt-4 flex-1 flex flex-col gap-3 text-[13px]">
            <span className="text-[11px] text-faint uppercase tracking-wider">Example of how it will work</span>
            <div className="self-end badge b-pink" style={{ padding: "8px 12px", whiteSpace: "normal", maxWidth: "85%" }}>{query || "Manufacturers in India with more than 30 employees"}</div>
            <div className="text-txt-2" style={{ maxWidth: "90%" }}>
              <b className="text-txt font-medium">Agent</b> → Apollo filters: <span className="badge b-gray">Industry: Manufacturing</span> <span className="badge b-gray">Country: India</span> <span className="badge b-gray">Employees: 31+</span>
              <div className="mt-2">≈ 1,240 people · enrichment costs ~1,240 credits. <span className="text-pink">Approve · Edit · Limit to 200</span></div>
            </div>
          </div>
          <form className="ask mt-4" onSubmit={(e) => e.preventDefault()}>
            <Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. HR heads at SaaS companies in Berlin, 50–500 employees" />
            <button className="badge b-gray" disabled title="Available in the next phase">Soon</button>
          </form>
        </article>

        <article className="card flex flex-col" style={{ minHeight: 360 }}>
          <h3 className="flex items-center gap-2"><FileUp width={18} /> Mode B · From a document</h3>
          <p className="card-sub">Upload an exhibitor list, directory or brochure (PDF, image, Excel/CSV). OCR + AI extracts company names; you pick who to target and approve the credit cost.</p>
          <div className="tile mt-4 flex flex-col items-center justify-center text-center" style={{ padding: 28, borderStyle: "dashed" }}>
            <FileUp width={28} className="text-pink mb-2" />
            <b className="font-medium text-[13.5px]">Drop a PDF, JPG/PNG or Excel/CSV</b>
            <span className="text-[12px] text-muted mt-1">Upload opens in the next phase</span>
          </div>
          <div className="field mt-4"><span>Who to target at each company</span>
            <div className="flex flex-wrap gap-1.5">{TARGETS.map((t) => <span key={t} className="chip"><span>{t}</span></span>)}</div>
          </div>
          <div className="mt-auto pt-4 flex items-center gap-2 text-[12px] text-muted"><Users width={14} /> Results are deduped, optionally verified, and saved to a lead list. <Sparkles width={14} /></div>
        </article>
      </div>
    </>
  );
}
