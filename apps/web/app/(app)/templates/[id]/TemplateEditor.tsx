"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Braces, Eye, MousePointerClick, Save, Sparkles, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RichEditor, type RichEditorHandle } from "@/components/RichEditor";
import { toast } from "@/components/toast";
import { Field, Modal, Skeleton, Spinner, Toggle } from "@/components/ui";
import { get, post, put } from "@/lib/api";
import type { Contact, Integration, Paged, Template } from "@/lib/types";

type Var = { key: string; label: string };
interface Vars { standard: Var[]; custom: Var[]; research?: Var[]; system: Var[] }
interface Preview { subject: string; html: string; contact: string | null; variables: string[]; missing: string[] }

export default function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  // Always load the saved copy when the editor opens: the editor keeps its own draft state from `initial`, so a
  // cached copy from an earlier visit (before the last save) would otherwise show up as the template's content.
  // staleTime: Infinity only stops background refetches while editing.
  const tq = useQuery({ queryKey: ["template", id], queryFn: () => get<Template>(`/templates/${id}`), staleTime: Infinity, refetchOnMount: "always" });
  if (!tq.data || !tq.isFetchedAfterMount) return <Skeleton h={480} />;
  return <Editor key={id} initial={tq.data} />;
}

function Editor({ initial }: { initial: Template }) {
  const id = initial.id;
  const qc = useQueryClient();
  const ed = useRef<RichEditorHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [t, setT] = useState<Template | null>(initial);
  const [dirty, setDirty] = useState(false);
  const [target, setTarget] = useState<"body" | "subject">("body");
  const [varOpen, setVarOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [contactId, setContactId] = useState("");

  const vars = useQuery({ queryKey: ["variables"], queryFn: () => get<Vars>("/variables") });
  const contacts = useQuery({ queryKey: ["contacts-sample"], queryFn: () => get<Paged<Contact>>("/contacts?size=20") });
  const ai = useQuery({ queryKey: ["integrations"], queryFn: () => get<Integration[]>("/integrations") });
  const hasAi = ai.data?.some((i) => i.kind === "ai");

  const preview = useMutation({ mutationFn: () => post<Preview>("/templates/preview", { subject: t!.subject, body_html: t!.body_html, contact_id: contactId || null }) });
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => preview.mutate(), 500);
    return () => clearTimeout(h);
  }, [t?.subject, t?.body_html, contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => put<Template>(`/templates/${id}`, { name: t!.name, subject: t!.subject, body_html: t!.body_html, track_opens: t!.track_opens, track_clicks: t!.track_clicks }),
    onSuccess: (saved) => { setT((cur) => cur && { ...cur, variables: saved.variables }); setDirty(false); toast.ok("Template saved"); qc.setQueryData(["template", id], saved); qc.invalidateQueries({ queryKey: ["templates"] }); },
    onError: toast.err,
  });
  const assist = useMutation({
    mutationFn: (mode: string) => post<{ subject: string; body_html: string }>("/templates/assist", { instruction: brief, subject: t!.subject, body_html: t!.body_html, mode }),
    onSuccess: (r) => { update({ subject: r.subject, body_html: r.body_html }); setAiOpen(false); toast.ok("Draft updated — review before saving"); },
    onError: toast.err,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (t) save.mutate(); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!t) return <Skeleton h={480} />;
  function update(p: Partial<Template>) { setT((cur) => cur && { ...cur, ...p }); setDirty(true); }

  function insertVar(key: string) {
    const token = `{{${key}}}`;
    if (target === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const pos = el.selectionStart ?? t!.subject.length;
      update({ subject: t!.subject.slice(0, pos) + token + t!.subject.slice(pos) });
    } else ed.current?.insert(token);
    setVarOpen(false);
  }

  const allVars = [...(vars.data?.standard ?? []), ...(vars.data?.custom ?? []), ...(vars.data?.research ?? []), ...(vars.data?.system ?? [])];

  return (
    <>
      <header className="head in">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link href="/templates" className="btn btn-icon btn-dark" aria-label="Back"><ArrowLeft /></Link>
          <input className="input" style={{ fontSize: 20, background: "transparent", boxShadow: "none", padding: "4px 6px" }} value={t.name} onChange={(e) => update({ name: e.target.value })} aria-label="Template name" />
        </div>
        <div className="flex gap-2">
          <button className="btn btn-dark" onClick={() => setAiOpen(true)}><Sparkles /> AI assist</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>{save.isPending ? <Spinner /> : <><Save /> {dirty ? "Save" : "Saved"}</>}</button>
        </div>
      </header>

      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(320px, 1fr)", ["--d" as string]: 1 }}>
        <article className="card" style={{ padding: 0 }}>
          <div className="p-4" style={{ borderBottom: "1px solid var(--stroke)" }}>
            <label className="field">
              <span>Subject <small className="text-faint">— spintax like {"{Quick|Short}"} question works here too. Leave empty for in-thread follow-ups.</small></span>
              <input ref={subjectRef} className="input" value={t.subject} onFocus={() => setTarget("subject")} onChange={(e) => update({ subject: e.target.value })} placeholder="Quick question for {{Company}}" />
            </label>
          </div>
          <div onFocus={() => setTarget("body")}>
            <RichEditor ref={ed} value={t.body_html} onChange={(html) => update({ body_html: html })} onVariables={() => { setTarget("body"); setVarOpen(true); }} />
          </div>
          <div className="p-4 flex flex-wrap gap-5 items-center" style={{ borderTop: "1px solid var(--stroke)" }}>
            <label className="flex items-center gap-2.5 text-[13px]"><Toggle on={t.track_opens} onChange={(v) => update({ track_opens: v })} label="Open tracking" /><Eye width={15} /> Track opens</label>
            <label className="flex items-center gap-2.5 text-[13px]"><Toggle on={t.track_clicks} onChange={(v) => update({ track_clicks: v })} label="Click tracking" /><MousePointerClick width={15} /> Track link & button clicks</label>
            <span className="text-[11.5px] text-muted">Links are rewritten through your tracking domain when sent. Unsubscribe links are never tracked.</span>
          </div>
        </article>

        <div className="flex flex-col gap-4">
          <article className="card">
            <div className="flex items-center justify-between gap-2">
              <h3>Live preview</h3>
              <select className="select" style={{ width: 220, padding: "7px 34px 7px 12px", fontSize: 12.5 }} value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">First lead in your account</option>
                {contacts.data?.items.map((c) => <option key={c.id} value={c.id}>{c.email}</option>)}
              </select>
            </div>
            {preview.data ? (
              <>
                <p className="text-[12px] text-muted mt-3">{preview.data.contact ? `Rendered for ${preview.data.contact}` : "No leads yet — variables use their fallbacks"}</p>
                <div className="preview-frame mt-2">
                  <div style={{ fontWeight: 700, marginBottom: 12, borderBottom: "1px solid #eee", paddingBottom: 10 }}>{preview.data.subject || <i style={{ color: "#999" }}>(no subject — sent as Re: of the previous email)</i>}</div>
                  <div dangerouslySetInnerHTML={{ __html: preview.data.html }} />
                </div>
                {preview.data.missing.length > 0 && (
                  <p className="badge b-amber mt-3" style={{ whiteSpace: "normal", padding: "7px 10px" }}>
                    This lead has no value for {preview.data.missing.map((m) => `{{${m}}}`).join(", ")} — add a fallback like {`{{${preview.data.missing[0]}|there}}`}.
                  </p>
                )}
              </>
            ) : <Skeleton h={200} className="mt-3" />}
          </article>
          <article className="card">
            <h3 className="flex items-center gap-2"><Braces width={17} /> Variables</h3>
            <p className="card-sub">Click to insert at the cursor ({target}). Use <code className="text-pink">{"{{Name|fallback}}"}</code> for empty values.</p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {allVars.map((v) => <button key={v.key} className="badge b-pink" style={{ cursor: "pointer", fontSize: 12 }} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v.key)}>{`{{${v.key}}}`}</button>)}
            </div>
            {!vars.data?.custom.length && <p className="text-[11.5px] text-muted mt-3">CSV columns you import (e.g. Industry) appear here automatically.</p>}
          </article>
        </div>
      </div>

      <Modal open={varOpen} onClose={() => setVarOpen(false)} title="Insert variable">
        {(["standard", "custom", "research", "system"] as const).map((g) => vars.data?.[g]?.length ? (
          <div key={g} className="mb-4">
            <div className="nav-label" style={{ padding: "0 0 8px" }}>{g === "standard" ? "Lead fields" : g === "custom" ? "From your CSVs / Apollo" : g === "research" ? "From Research leads (website audit + keywords)" : "System"}</div>
            <div className="flex flex-wrap gap-1.5">{vars.data[g]!.map((v) => <button key={v.key} className="chip" onClick={() => insertVar(v.key)} title={`{{${v.key}}}`}><span>{v.label}</span></button>)}</div>
          </div>
        ) : null)}
      </Modal>

      <Modal open={aiOpen} onClose={() => setAiOpen(false)} title="AI assist" sub="Uses the AI provider you connected in Settings.">
        {!hasAi ? (
          <p className="text-[13.5px] text-txt-2">Connect an AI key (OpenAI, Anthropic, Gemini, OpenRouter or custom) in <Link className="text-pink" href="/settings">Settings → Integrations</Link> first.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="What should the email say?"><textarea className="textarea" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Cold email to HR heads at mid-size manufacturers about our payroll automation. Ask for a 15-min call." /></Field>
            <div className="flex gap-2 justify-end flex-wrap">
              <button className="btn btn-dark" disabled={assist.isPending || !t.body_html} onClick={() => assist.mutate("shorten")}>Shorten current</button>
              <button className="btn btn-dark" disabled={assist.isPending || !brief || !t.body_html} onClick={() => assist.mutate("rewrite")}>Rewrite current</button>
              <button className="btn btn-primary" disabled={assist.isPending || !brief} onClick={() => assist.mutate("write")}>{assist.isPending ? <Spinner /> : <><WandSparkles /> Write draft</>}</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
