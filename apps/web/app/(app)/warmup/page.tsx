"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, Info } from "lucide-react";
import { toast } from "@/components/toast";
import { Empty, Field, PageHeader, ProviderBadge, Skeleton, Toggle } from "@/components/ui";
import { get, patch } from "@/lib/api";
import type { Mailbox } from "@/lib/types";

export default function WarmupPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes") });
  const save = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Mailbox> }) => patch<Mailbox>(`/mailboxes/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailboxes"] }),
    onError: toast.err,
  });

  return (
    <>
      <PageHeader title="Warmup" sub="Mailboxes in the shared pool send to each other; our IMAP worker moves warmup mail out of spam and replies, building reputation" />
      <div className="card in flex gap-3 items-start" style={{ boxShadow: "inset 0 0 0 1px rgba(142,197,255,.35)" }}>
        <Info color="var(--blue)" width={18} className="flex-none mt-0.5" />
        <p className="text-[13px] text-txt-2">
          Warmup settings and pool membership are saved now. The warmup sender + IMAP spam-rescue worker is the next build phase — once it ships,
          every mailbox switched on here starts ramping automatically with these settings. Imap access is required (SMTP mailboxes need an IMAP host).
        </p>
      </div>
      {q.isLoading ? <Skeleton h={200} /> : !q.data?.length ? <article className="card"><Empty icon={<Flame />} title="Connect a mailbox first" /></article> : (
        <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", ["--d" as string]: 1 }}>
          {q.data.map((m) => {
            const w = m.warmup;
            const set = (k: keyof Mailbox["warmup"], v: number) => save.mutate({ id: m.id, body: { warmup: { ...w, [k]: v } } });
            const noImap = m.provider === "smtp" && !m.imap_host;
            return (
              <article key={m.id} className={`card ${m.warmup_enabled ? "glow" : ""}`}>
                <div className="flex items-center gap-3">
                  <ProviderBadge provider={m.provider} />
                  <div className="min-w-0 flex-1"><b className="font-normal block truncate-1">{m.email}</b><small className="text-[11.5px] text-muted">{m.warmup_enabled ? "In warmup pool" : "Not warming"}</small></div>
                  <Toggle on={m.warmup_enabled} label="Warmup" onChange={(v) => save.mutate({ id: m.id, body: { warmup_enabled: v } })} />
                </div>
                {noImap && <p className="badge b-amber mt-3" style={{ whiteSpace: "normal" }}>Add an IMAP host to this mailbox — warmup needs it.</p>}
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <Field label="Start / day"><input className="input" type="number" min={1} defaultValue={w.start_per_day} onBlur={(e) => +e.target.value !== w.start_per_day && set("start_per_day", +e.target.value)} /></Field>
                  <Field label="Increase / day"><input className="input" type="number" min={0} defaultValue={w.ramp_per_day} onBlur={(e) => +e.target.value !== w.ramp_per_day && set("ramp_per_day", +e.target.value)} /></Field>
                  <Field label="Max / day"><input className="input" type="number" min={1} defaultValue={w.max_per_day} onBlur={(e) => +e.target.value !== w.max_per_day && set("max_per_day", +e.target.value)} /></Field>
                  <Field label="Reply rate %"><input className="input" type="number" min={0} max={100} defaultValue={w.reply_rate} onBlur={(e) => +e.target.value !== w.reply_rate && set("reply_rate", +e.target.value)} /></Field>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
