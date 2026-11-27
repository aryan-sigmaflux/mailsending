"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, Info } from "lucide-react";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, PageHeader, ProviderBadge, Skeleton, Toggle } from "@/components/ui";
import { get, patch } from "@/lib/api";
import { longDate } from "@/lib/format";
import type { Mailbox } from "@/lib/types";

const DAY_MS = 86_400_000;

/** Where a mailbox is on its ramp-up: day N, today's warmup volume, and when it reaches max volume. */
function rampProgress(m: Pick<Mailbox, "warmup" | "warmup_enabled" | "warmup_started_at">, now = Date.now()) {
  const { start_per_day: start, ramp_per_day: ramp, max_per_day: max } = m.warmup;
  // Days to reach max volume (day 1 sends `start`, each day adds `ramp`); null = never (no increase and start < max).
  const totalDays = start >= max ? 1 : ramp > 0 ? Math.ceil((max - start) / ramp) + 1 : null;
  if (!m.warmup_enabled || !m.warmup_started_at) return { active: false as const, totalDays, max };
  const started = new Date(m.warmup_started_at).getTime();
  const day = Math.max(1, Math.floor((now - started) / DAY_MS) + 1);
  const perDay = Math.min(max, start + ramp * (day - 1));
  const done = totalDays != null && day >= totalDays;
  const fullOn = totalDays != null ? new Date(started + (totalDays - 1) * DAY_MS) : null;
  const percent = totalDays ? Math.min(100, Math.round((day / totalDays) * 100)) : Math.round((perDay / max) * 100);
  return { active: true as const, day, perDay, max, totalDays, done, fullOn, percent };
}

function RampBar({ m }: { m: Mailbox }) {
  const r = rampProgress(m);
  if (!r.active) {
    return (
      <div className="mt-4">
        <div className="flex justify-between text-[12px] text-muted mb-1.5"><span>Ramp-up</span><span>not started</span></div>
        <Meter value={0} max={1} />
        <p className="text-[11.5px] text-muted mt-1.5">{r.totalDays ? `Takes ${r.totalDays} day${r.totalDays > 1 ? "s" : ""} to reach ${r.max}/day once switched on.` : `“Increase / day” is 0, so it never reaches ${r.max}/day.`}</p>
      </div>
    );
  }
  return (
    <div className="mt-4" title={r.fullOn ? `Full volume (${r.max}/day) on ${longDate(r.fullOn)}` : undefined}>
      <div className="flex justify-between text-[12px] mb-1.5">
        <span className="text-txt-2">{r.done ? "Ramp-up complete" : `Day ${r.day}${r.totalDays ? ` of ${r.totalDays}` : ""}`}</span>
        <span className={r.done ? "text-green" : "text-pink"}>{r.percent}%</span>
      </div>
      <Meter value={r.percent} max={100} tone={r.done ? "green" : "pink"} />
      <p className="text-[11.5px] text-muted mt-1.5">
        {r.perDay} / {r.max} warmup emails per day
        {r.done ? " · at full volume" : r.fullOn ? ` · full volume on ${longDate(r.fullOn)}` : " · no daily increase set"}
      </p>
    </div>
  );
}

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
                <RampBar m={m} />
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
