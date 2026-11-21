"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FileText, MousePointerClick, Plus, Trash } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Empty, PageHeader, Skeleton, confirmAction } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Template } from "@/lib/types";

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export default function TemplatesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/templates") });
  const create = useMutation({ mutationFn: () => post<Template>("/templates", { name: "Untitled template", subject: "", body_html: "" }), onSuccess: (t) => router.push(`/templates/${t.id}`), onError: toast.err });
  const dup = useMutation({ mutationFn: (id: string) => post(`/templates/${id}/duplicate`), onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }), onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/templates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }), onError: toast.err });

  return (
    <>
      <PageHeader title="Templates" sub="Reusable emails with {{variables}}, spintax, buttons and click tracking"
        actions={<button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}><Plus /> New template</button>} />
      {q.isLoading ? <Skeleton h={160} /> : !q.data?.length ? (
        <article className="card"><Empty icon={<FileText />} title="No templates yet" action={<button className="btn btn-primary" onClick={() => create.mutate()}><Plus /> Write your first template</button>}>Templates are used by campaigns and by Send Mail nodes in sequences.</Empty></article>
      ) : (
        <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))" }}>
          {q.data.map((t, i) => (
            <article key={t.id} className="card hoverable flex flex-col" style={{ animation: `rowIn .5s var(--ease) ${i * 50}ms backwards`, minHeight: 190 }}>
              <Link href={`/templates/${t.id}`} className="flex-1">
                <h3 className="truncate-1">{t.name}</h3>
                <p className="text-[13px] mt-2 truncate-1">{t.subject || <span className="text-faint">No subject (follow-up)</span>}</p>
                <p className="text-[12px] text-muted mt-1.5" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{strip(t.body_html) || "Empty"}</p>
              </Link>
              <div className="flex items-center gap-1.5 mt-4 flex-wrap">
                {t.variables.slice(0, 3).map((v) => <span key={v} className="badge b-pink">{`{{${v}}}`}</span>)}
                {t.track_clicks && <span className="badge b-gray" title="Click tracking on"><MousePointerClick /> tracked</span>}
                <span className="flex-1" />
                <span className="text-[11px] text-muted">{ago(t.updated_at)}</span>
                <button className="btn btn-icon btn-sm btn-dark" title="Duplicate" onClick={() => dup.mutate(t.id)}><Copy /></button>
                <button className="btn btn-icon btn-sm btn-danger" title="Delete" onClick={() => confirmAction(`Delete “${t.name}”?`) && remove.mutate(t.id)}><Trash /></button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
