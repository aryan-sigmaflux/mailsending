"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pause, Play, Plus, Send, Trash } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Meter, PageHeader, Seg, Skeleton, StatusBadge, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago, num, pct } from "@/lib/format";
import type { Campaign } from "@/lib/types";

type Filter = "all" | "running" | "draft" | "paused" | "completed";

export default function CampaignsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const q = useQuery({ queryKey: ["campaigns"], queryFn: () => get<Campaign[]>("/campaigns"), refetchInterval: 20_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["campaigns"] });

  const create = useMutation({ mutationFn: () => post<Campaign>("/campaigns", { name: "New campaign", kind: "single" }), onSuccess: (c) => router.push(`/campaigns/${c.id}`), onError: toast.err });
  useEffect(() => { if (new URLSearchParams(location.search).get("new")) { history.replaceState(null, "", "/campaigns"); create.mutate(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useMutation({ mutationFn: ({ id, a }: { id: string; a: string }) => post(`/campaigns/${id}/${a}`, a === "launch" ? { missing_policy: "fallback" } : undefined), onSuccess: refresh, onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/campaigns/${id}`), onSuccess: refresh, onError: toast.err });

  const list = (q.data ?? []).filter((c) => filter === "all" || c.status === filter);
  const count = (s: Filter) => (q.data ?? []).filter((c) => s === "all" || c.status === s).length;

  return (
    <>
      <PageHeader title="Campaigns" sub="Send a single template or a multi-step sequence to your lead lists"
        actions={<button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}><Plus /> New campaign</button>} />
      <div className="in"><Seg value={filter} onChange={setFilter} options={(["all", "running", "draft", "paused", "completed"] as Filter[]).map((f) => ({ value: f, label: `${f[0].toUpperCase()}${f.slice(1)} · ${count(f)}` }))} /></div>
      <article className="card in" style={{ padding: 6, ["--d" as string]: 1 }}>
        {q.isLoading ? <div className="p-4"><Skeleton h={160} /></div> : !list.length ? (
          <Empty icon={<Send />} title={filter === "all" ? "No campaigns yet" : `No ${filter} campaigns`} action={filter === "all" && <button className="btn btn-primary" onClick={() => create.mutate()}><Plus /> Create campaign</button>}>
            {filter === "all" && "Pick your leads, mailboxes and a template or sequence, then launch."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Campaign</th><th>Status</th><th style={{ width: 170 }}>Progress</th><th>Sent</th><th>Opened</th><th>Replied</th><th>Bounced</th><th /></tr></thead>
              <tbody>
                {list.map((c) => {
                  const s = c.stats;
                  const done = s.contacts - s.live;
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/campaigns/${c.id}`} className="block">
                          <div className="truncate-1 max-w-[280px]">{c.name}</div>
                          <div className="text-[11.5px] text-muted">{c.kind === "sequence" ? "Sequence" : `Single template${c.template_ids.length > 1 ? ` · ${c.template_ids.length} variants` : ""}`} · {c.started_at ? `started ${ago(c.started_at)}` : `created ${ago(c.created_at)}`}</div>
                        </Link>
                      </td>
                      <td><StatusBadge status={c.status} /></td>
                      <td>{s.contacts ? <><div className="text-[12px] mb-1.5">{num(done)} / {num(s.contacts)} leads</div><Meter value={done} max={s.contacts} /></> : <span className="text-faint text-[12px]">Not launched</span>}</td>
                      <td>{num(s.sent)}</td>
                      <td>{num(s.opened)} <span className="text-muted text-[11px]">{pct(s.opened, s.sent)}</span></td>
                      <td>{num(s.replied)} <span className="text-muted text-[11px]">{pct(s.replied, s.sent)}</span></td>
                      <td className={s.sent && s.bounced / s.sent > 0.03 ? "text-red" : ""}>{num(s.bounced)}</td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {c.status === "running" && <button className="btn btn-icon btn-sm btn-dark" title="Pause" onClick={() => act.mutate({ id: c.id, a: "pause" })}><Pause /></button>}
                          {c.status === "paused" && <button className="btn btn-icon btn-sm btn-dark" title="Resume" onClick={() => act.mutate({ id: c.id, a: "launch" })}><Play /></button>}
                          <button className="btn btn-icon btn-sm btn-dark" title="Duplicate" onClick={() => act.mutate({ id: c.id, a: "duplicate" })}><Copy /></button>
                          <button className="btn btn-icon btn-sm btn-danger" title="Delete" onClick={() => confirmAction(`Delete “${c.name}” and its stats?`) && remove.mutate(c.id)}><Trash /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </>
  );
}
