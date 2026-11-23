"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { RichEditor } from "@/components/RichEditor";
import { toast } from "@/components/toast";
import { Field, Modal, Spinner, Toggle } from "@/components/ui";
import { get, post } from "@/lib/api";
import type { Mailbox, Template } from "@/lib/types";

const EMPTY = { mailbox_id: "", to: "", subject: "", body_html: "", template_id: "", track_opens: true, track_clicks: false };

/** Write and send a single email from one of the user's mailboxes (outside any campaign). */
export function ComposeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(EMPTY);
  const set = (p: Partial<typeof EMPTY>) => setF((s) => ({ ...s, ...p }));
  const mbs = useQuery({ queryKey: ["mailboxes"], queryFn: () => get<Mailbox[]>("/mailboxes"), enabled: open });
  const tpls = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/templates"), enabled: open });
  const usable = (mbs.data ?? []).filter((m) => m.status !== "paused");

  // Default to the first healthy mailbox until the user picks one.
  const mailboxId = f.mailbox_id || (usable.find((m) => m.status === "active") ?? usable[0])?.id || "";

  const pickTemplate = (id: string) => {
    const t = tpls.data?.find((x) => x.id === id);
    set(t ? { template_id: id, subject: t.subject, body_html: t.body_html, track_opens: t.track_opens, track_clicks: t.track_clicks } : { template_id: "" });
  };

  const send = useMutation({
    mutationFn: () => post<{ to: string }>("/messages/send", { ...f, mailbox_id: mailboxId, to: f.to.trim(), template_id: f.template_id || null }),
    onSuccess: (r) => {
      toast.ok(`Email sent to ${r.to}`);
      setF((s) => ({ ...EMPTY, mailbox_id: s.mailbox_id }));
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["single-messages"] });
      onClose();
    },
    onError: toast.err,
  });

  const bodyEmpty = !f.body_html.replace(/<[^>]*>/g, "").trim();
  const ready = mailboxId && /^\S+@\S+\.\S+$/.test(f.to.trim()) && f.subject.trim() && !bodyEmpty;

  return (
    <Modal open={open} onClose={onClose} wide title="New email" sub="Send a single email — opens, clicks and replies are tracked like campaign emails."
      footer={<>
        <button className="btn btn-dark" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!ready || send.isPending} onClick={() => send.mutate()}>{send.isPending ? <Spinner /> : <><Send /> Send</>}</button>
      </>}>
      {mbs.data && !usable.length ? (
        <div className="tile text-[13px] text-txt-2">You need a connected mailbox to send email. <Link className="text-pink" href="/mailboxes">Connect one →</Link></div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <Field label="From">
              <select className="select" value={mailboxId} onChange={(e) => set({ mailbox_id: e.target.value })}>
                {usable.map((m) => <option key={m.id} value={m.id}>{m.from_name ? `${m.from_name} <${m.email}>` : m.email}{m.status !== "active" ? ` (${m.status})` : ""}</option>)}
              </select>
            </Field>
            <Field label="To">
              <input className="input" type="email" placeholder="name@company.com" value={f.to} onChange={(e) => set({ to: e.target.value })} autoFocus />
            </Field>
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <Field label="Subject"><input className="input" value={f.subject} onChange={(e) => set({ subject: e.target.value })} /></Field>
            <Field label="Start from a template (optional)">
              <select className="select" value={f.template_id} onChange={(e) => pickTemplate(e.target.value)}>
                <option value="">— Blank email —</option>
                {tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="field">
            <span>Message <small>— {"{{variables}}"} fill in from the lead&apos;s record when the address is in your lead lists; your mailbox signature is added automatically</small></span>
            <RichEditor value={f.body_html} onChange={(html) => set({ body_html: html })} />
          </div>
          <div className="flex gap-6 flex-wrap text-[13px]">
            <label className="flex items-center gap-2.5"><Toggle on={f.track_opens} onChange={(v) => set({ track_opens: v })} label="Track opens" /> Track opens</label>
            <label className="flex items-center gap-2.5"><Toggle on={f.track_clicks} onChange={(v) => set({ track_clicks: v })} label="Track clicks" /> Track clicks</label>
          </div>
        </div>
      )}
    </Modal>
  );
}
