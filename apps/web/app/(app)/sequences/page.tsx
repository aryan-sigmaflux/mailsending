"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash, Workflow } from "lucide-react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { Empty, PageHeader, Skeleton, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Sequence } from "@/lib/types";

export default function SequencesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sequences"], queryFn: () => get<Sequence[]>("/sequences") });
  const dup = useMutation({ mutationFn: (id: string) => post(`/sequences/${id}/duplicate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }), onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/sequences/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }), onError: toast.err });

  return (
    <>
      <PageHeader title="Sequences" sub="Visual multi-step workflows: Start → Send Mail → Wait → Condition"
        actions={<Link href="/sequences/new" className="btn btn-primary"><Plus /> New sequence</Link>} />
      {q.isLoading ? <Skeleton h={160} /> : !q.data?.length ? (
        <article className="card"><Empty icon={<Workflow />} title="No sequences yet" action={<Link href="/sequences/new" className="btn btn-primary"><Plus /> Build a sequence</Link>}>Chain emails, waits and open/click/reply conditions on a canvas — or import one from JSON.</Empty></article>
      ) : (
        <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))" }}>
          {q.data.map((s, i) => {
            const counts = s.graph.nodes.reduce<Record<string, number>>((a, n) => ({ ...a, [n.type]: (a[n.type] ?? 0) + 1 }), {});
            return (
              <article key={s.id} className="card hoverable flex flex-col" style={{ animation: `rowIn .5s var(--ease) ${i * 50}ms backwards`, minHeight: 150 }}>
                <Link href={`/sequences/${s.id}`} className="flex-1">
                  <h3>{s.name}</h3>
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    <span className="badge b-pink">{counts.send ?? 0} emails</span>
                    <span className="badge b-blue">{counts.wait ?? 0} waits</span>
                    {counts.condition ? <span className="badge b-amber">{counts.condition} conditions</span> : null}
                  </div>
                </Link>
                <div className="flex items-center gap-1.5 mt-4">
                  <span className="text-[11px] text-muted flex-1">Edited {ago(s.updated_at)}</span>
                  <button className="btn btn-icon btn-sm btn-dark" title="Duplicate" onClick={() => dup.mutate(s.id)}><Copy /></button>
                  <button className="btn btn-icon btn-sm btn-danger" title="Delete" onClick={() => confirmAction(`Delete “${s.name}”?`) && remove.mutate(s.id)}><Trash /></button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
