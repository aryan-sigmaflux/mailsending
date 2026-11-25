"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import { ArrowLeft, Braces, ChevronDown, CircleExclamationPoint, Clock, Copy, Download, FileBraces, GitBranch, Mail, Play, Plus, Save, Search, Trash, Upload, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { Field, Skeleton, Spinner, confirmAction } from "@/components/ui";
import { get, post, put } from "@/lib/api";
import { importProblems, parseSequenceJson, resolvePending, sampleSequenceJson, type ImportResult } from "@/lib/sequenceJson";
import { csvColumns, sequenceVariables } from "@/lib/templateVars";
import type { GraphEdge, GraphNode, NodeKind, ResearchCatalog, Sequence, Template } from "@/lib/types";

type Data = Record<string, unknown>;
const TemplatesCtx = createContext<Template[]>([]);

const META: Record<NodeKind, { label: string; icon: React.ReactNode; color: string }> = {
  start: { label: "Start", icon: <Play />, color: "rgba(79,214,127,.16)" },
  send: { label: "Send Mail", icon: <Mail />, color: "rgba(238,178,220,.18)" },
  wait: { label: "Wait", icon: <Clock />, color: "rgba(142,197,255,.16)" },
  condition: { label: "Condition", icon: <GitBranch />, color: "rgba(245,194,107,.16)" },
};

function waitText(d: Data) {
  const parts = [d.days ? `${d.days}d` : "", d.hours ? `${d.hours}h` : "", d.minutes ? `${d.minutes}m` : ""].filter(Boolean);
  return `${parts.join(" ") || "0m"}${d.working_days_only ? " · working days only" : ""}`;
}

function Shell({ kind, selected, children, title }: { kind: NodeKind; selected?: boolean; children?: React.ReactNode; title?: string }) {
  const m = META[kind];
  return (
    <div className={`flow-node ${selected ? "selected" : ""}`}>
      <div className="fh"><i style={{ background: m.color }}>{m.icon}</i>{title || m.label}</div>
      {children && <div className="fb">{children}</div>}
    </div>
  );
}

function StartNode({ selected }: NodeProps) {
  return (
    <>
      <Shell kind="start" selected={selected}>Lead is enrolled in the campaign</Shell>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

function SendNode({ data, selected }: NodeProps) {
  const templates = useContext(TemplatesCtx);
  const ids = (data.template_ids as string[]) ?? [];
  const names = ids.map((i) => templates.find((t) => t.id === i)?.name ?? "deleted template");
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Shell kind="send" selected={selected} title={(data.label as string) || "Send Mail"}>
        {ids.length === 0 ? <span className="text-red">Select a template</span> : ids.length === 1 ? names[0] : <>Random of {ids.length}: {names.join(", ")}</>}
        {data.same_thread !== false && <div className="text-muted mt-1">↳ reply in same thread</div>}
      </Shell>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

function WaitNode({ data, selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Shell kind="wait" selected={selected} title={(data.label as string) || "Wait"}>{waitText(data)}</Shell>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

/** Issue codes + research metrics (GET /research/catalog), shared by condition nodes and the inspector. */
function useCatalog() {
  return useQuery({ queryKey: ["research-catalog"], queryFn: () => get<ResearchCatalog>("/research/catalog"), staleTime: Infinity }).data;
}

const OPS: Record<string, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=", neq: "≠" };
const FIELD_OPS: [string, string][] = [
  ["equals", "equals"], ["not_equals", "doesn't equal"], ["contains", "contains"], ["empty", "is empty"], ["not_empty", "is not empty"],
  ["gt", "is greater than (number)"], ["lt", "is less than (number)"], ["gte", "is at least (number)"], ["lte", "is at most (number)"],
];

function conditionText(d: Data, cat?: ResearchCatalog): React.ReactNode {
  const check = (d.check as string) ?? "opened";
  if (["opened", "clicked", "replied"].includes(check)) return <>If lead <b className="text-txt">{check}</b> any previous email</>;
  if (check === "researched") return <>If the lead&apos;s website <b className="text-txt">has been researched</b></>;
  if (check === "site_issue") {
    const codes = (d.issues as string[]) ?? [];
    const names = codes.map((c) => cat?.issues.find((i) => i.code === c)?.title ?? c);
    if (!names.length) return <span className="text-red">Pick website issues</span>;
    return <>If website has {names.length > 1 ? (d.match === "all" ? "all of" : "any of") : ""} <b className="text-txt">{names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</b></>;
  }
  if (check === "metric") {
    const m = cat?.metrics.find((x) => x.key === d.metric)?.label ?? (d.metric as string) ?? "metric";
    return <>If <b className="text-txt">{m}</b> {OPS[(d.op as string) ?? "lt"]} <b className="text-txt">{String(d.value ?? "?")}</b></>;
  }
  if (check === "field") {
    const op = FIELD_OPS.find(([k]) => k === d.op)?.[1] ?? "equals";
    return <>If <b className="text-txt">{`{{${(d.field as string) || "field"}}}`}</b> {op}{["empty", "not_empty"].includes(d.op as string) ? "" : <> “<b className="text-txt">{String(d.value ?? "")}</b>”</>}</>;
  }
  return check;
}

function ConditionNode({ data, selected }: NodeProps) {
  const cat = useCatalog();
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Shell kind="condition" selected={selected} title={(data.label as string) || "Condition"}>
        {conditionText(data, cat)}
        <div className="flex justify-between mt-2 text-[11px]"><span className="text-green">Yes →</span></div>
        <div className="flex justify-between mt-3 text-[11px]"><span className="text-red">No →</span></div>
      </Shell>
      <Handle type="source" id="yes" position={Position.Right} style={{ top: "62%", background: "var(--green)" }} />
      <Handle type="source" id="no" position={Position.Right} style={{ top: "84%", background: "var(--red)" }} />
    </>
  );
}

const nodeTypes = { start: StartNode, send: SendNode, wait: WaitNode, condition: ConditionNode };

const toFlow = (g: Sequence["graph"]): { nodes: Node[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: n.data ?? {}, deletable: n.type !== "start" })),
  edges: g.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, animated: true, label: e.sourceHandle === "no" ? "No" : e.sourceHandle === "yes" ? "Yes" : undefined })),
});

const fromFlow = (nodes: Node[], edges: Edge[]): Sequence["graph"] => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeKind, position: n.position, data: n.data as Data }) satisfies GraphNode),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null }) satisfies GraphEdge),
});

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

/** Template checklist for a Send Mail step, with search (name, subject and body). Selected templates stay on top. */
function TemplatePicker({ templates, ids, onChange }: { templates: Template[]; ids: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = templates
    .filter((t) => !words.length || words.every((w) => `${t.name} ${t.subject} ${plain(t.body_html)}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)));
  return (
    <div className="field">
      <span>Templates {ids.length > 1 && <small className="text-pink">— one is picked at random per lead (even split)</small>}</span>
      {templates.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
          <input className="input" style={{ paddingLeft: 36, paddingRight: q ? 34 : undefined }} type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${templates.length} templates…`} aria-label="Search templates" />
          {q && <button type="button" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" onClick={() => setQ("")} aria-label="Clear search"><X className="w-4 h-4" /></button>}
        </div>
      )}
      {(q || ids.length > 0) && templates.length > 0 && (
        <small className="text-muted">{q ? `${shown.length} of ${templates.length} match` : ""}{q && ids.length ? " · " : ""}{ids.length ? `${ids.length} selected` : ""}</small>
      )}
      <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
        {templates.length === 0 && <small>No templates yet — <Link href="/templates" className="text-pink">create one</Link>.</small>}
        {templates.length > 0 && shown.length === 0 && <small className="text-muted py-2">No templates match “{q}”.</small>}
        {shown.map((t) => (
          <label key={t.id} className="check tile" style={{ padding: "9px 12px" }}>
            <input type="checkbox" checked={ids.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))} />
            <span className="min-w-0"><span className="block truncate-1">{t.name}</span><small className="text-muted truncate-1 block">{t.subject || "No subject — follow-up"}</small></span>
          </label>
        ))}
      </div>
    </div>
  );
}

type VarList = { standard: { key: string; label: string }[]; custom: { key: string; label: string }[]; research?: { key: string; label: string }[] };

/** Settings for a Condition node: engagement checks, website research checks, or any lead field. */
function ConditionForm({ d, onChange }: { d: Data; onChange: (d: Data) => void }) {
  const cat = useCatalog();
  const vars = useQuery({ queryKey: ["variables"], queryFn: () => get<VarList>("/variables") }).data;
  const [q, setQ] = useState("");
  const check = (d.check as string) ?? "opened";
  const picked = (d.issues as string[]) ?? [];
  const setCheck = (c: string) => {
    const base: Data = { label: d.label, check: c };
    if (c === "site_issue") Object.assign(base, { issues: [], match: "any" });
    if (c === "metric") Object.assign(base, { metric: "keyword_volume_max", op: "lt", value: 1000 });
    if (c === "field") Object.assign(base, { field: "", op: "equals", value: "" });
    onChange(base);
  };
  const research = ["researched", "site_issue", "metric"].includes(check);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const issues = (cat?.issues ?? []).filter((i) => !words.length || words.every((w) => `${i.title} ${i.code} ${i.category}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(picked.includes(b.code)) - Number(picked.includes(a.code)));
  const sev = { high: "b-red", medium: "b-amber", low: "b-gray" } as const;
  const fieldOptions = [...(vars?.standard ?? []), ...(vars?.custom ?? []), ...(vars?.research ?? [])];

  return (
    <div className="flex flex-col gap-3">
      <Field label="Branch on…">
        <select className="select" value={check} onChange={(e) => setCheck(e.target.value)}>
          <optgroup label="Engagement (this campaign)">
            <option value="opened">Opened an email</option>
            <option value="clicked">Clicked a link or button</option>
            <option value="replied">Replied</option>
          </optgroup>
          <optgroup label="Website research">
            <option value="site_issue">Website has an issue (e.g. multiple H1s)</option>
            <option value="metric">Research number (keyword volume, bids, site score…)</option>
            <option value="researched">Website has been researched</option>
          </optgroup>
          <optgroup label="Lead data">
            <option value="field">A lead field (CSV, Apollo or research)</option>
          </optgroup>
        </select>
      </Field>

      {check === "site_issue" && (
        <div className="field">
          <span>Issues {picked.length > 1 && (
            <select className="select" style={{ display: "inline-block", width: "auto", height: 28, padding: "0 28px 0 8px", marginLeft: 6, fontSize: 12 }} value={(d.match as string) ?? "any"} onChange={(e) => onChange({ ...d, match: e.target.value })}>
              <option value="any">any of these</option><option value="all">all of these</option>
            </select>
          )}</span>
          <input className="input" type="search" placeholder="Search issues…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search issues" />
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
            {!cat && <Skeleton h={80} />}
            {issues.map((i) => (
              <label key={i.code} className="check tile" style={{ padding: "7px 10px" }}>
                <input type="checkbox" checked={picked.includes(i.code)} onChange={(e) => onChange({ ...d, issues: e.target.checked ? [...picked, i.code] : picked.filter((x) => x !== i.code) })} />
                <span className="min-w-0 flex-1"><span className="block truncate-1 text-[12.5px]">{i.title}</span><small className="text-muted">{i.category}</small></span>
                <span className={`badge ${sev[i.severity]}`}>{i.severity}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {check === "metric" && (
        <>
          <Field label="Metric">
            <select className="select" value={(d.metric as string) ?? ""} onChange={(e) => onChange({ ...d, metric: e.target.value })}>
              {(cat?.metrics ?? []).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Is">
              <select className="select" value={(d.op as string) ?? "lt"} onChange={(e) => onChange({ ...d, op: e.target.value })}>
                <option value="lt">less than</option><option value="lte">at most</option><option value="gt">greater than</option>
                <option value="gte">at least</option><option value="eq">exactly</option>
              </select>
            </Field>
            <Field label="Value"><input className="input" type="number" value={(d.value as number | string) ?? ""} onChange={(e) => onChange({ ...d, value: e.target.value === "" ? "" : +e.target.value })} /></Field>
          </div>
        </>
      )}

      {check === "field" && (
        <>
          <Field label="Field" hint="Type any CSV column name, or pick one.">
            <input className="input" list="cond-fields" value={(d.field as string) ?? ""} onChange={(e) => onChange({ ...d, field: e.target.value })} placeholder="e.g. Industry" />
            <datalist id="cond-fields">{fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</datalist>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Condition">
              <select className="select" value={(d.op as string) ?? "equals"} onChange={(e) => onChange({ ...d, op: e.target.value })}>
                {FIELD_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            {!["empty", "not_empty"].includes(d.op as string) && <Field label="Value"><input className="input" value={(d.value as string) ?? ""} onChange={(e) => onChange({ ...d, value: e.target.value })} /></Field>}
          </div>
        </>
      )}

      <small className="text-[11.5px] text-muted">
        {research
          ? <>Uses the lead&apos;s <Link href="/leads/research" className="text-pink">website research</Link>. Leads that haven&apos;t been researched (or have no data for this number) take the <b className="text-red">No</b> branch — add a &ldquo;Website has been researched&rdquo; check first to route them separately.</>
          : check === "field" ? "Text comparisons ignore upper/lower case. Number comparisons ignore thousands separators (74,000)." : "Checked against every email sent to this lead in the campaign so far."}
      </small>
    </div>
  );
}

function Inspector({ node, onChange, onDelete, templates }: { node: Node | null; onChange: (d: Data) => void; onDelete: () => void; templates: Template[] }) {
  if (!node) return <p className="text-[13px] text-muted">Select a node to edit it. Drag from a node&apos;s right handle to connect steps. Press Delete to remove a selected node or edge.</p>;
  const d = node.data as Data;
  const kind = node.type as NodeKind;
  const ids = (d.template_ids as string[]) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2"><span className="badge b-pink">{META[kind].label}</span><span className="flex-1" />{kind !== "start" && <button className="btn btn-sm btn-danger" onClick={onDelete}><Trash /> Remove</button>}</div>
      {kind !== "start" && <Field label="Label"><input className="input" value={(d.label as string) ?? ""} onChange={(e) => onChange({ ...d, label: e.target.value })} /></Field>}
      {kind === "send" && (
        <>
          <TemplatePicker key={node.id} templates={templates} ids={ids} onChange={(next) => onChange({ ...d, template_ids: next })} />
          <label className="check"><input type="checkbox" checked={d.same_thread !== false} onChange={(e) => onChange({ ...d, same_thread: e.target.checked })} /> Reply in the same thread as the previous email</label>
        </>
      )}
      {kind === "wait" && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {(["days", "hours", "minutes"] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><input className="input" type="number" min={0} value={(d[k] as number) ?? 0} onChange={(e) => onChange({ ...d, [k]: Math.max(0, +e.target.value) })} /></Field>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={!!d.working_days_only} onChange={(e) => onChange({ ...d, working_days_only: e.target.checked })} /> Working days only</label>
          <small className="text-[11.5px] text-muted">Working days are set per campaign (default Mon–Fri) in the campaign&apos;s time zone.</small>
        </>
      )}
      {kind === "condition" && <ConditionForm key={node.id} d={d} onChange={onChange} />}
    </div>
  );
}

/** What a brand-new sequence starts with (same as the API's default). Nothing is stored until the first Save. */
const DRAFT: Sequence = {
  id: "", name: "New sequence", description: "", created_at: "", updated_at: "",
  graph: {
    nodes: [
      { id: "start", type: "start", position: { x: 80, y: 200 }, data: { label: "Start" } },
      { id: "send-1", type: "send", position: { x: 360, y: 180 }, data: { label: "Email 1", template_ids: [], same_thread: true } },
      { id: "wait-1", type: "wait", position: { x: 660, y: 190 }, data: { label: "Wait", days: 2, hours: 0, minutes: 0, working_days_only: true } },
      { id: "send-2", type: "send", position: { x: 940, y: 180 }, data: { label: "Follow-up", template_ids: [], same_thread: true } },
    ],
    edges: [
      { id: "e1", source: "start", target: "send-1" },
      { id: "e2", source: "send-1", target: "wait-1" },
      { id: "e3", source: "wait-1", target: "send-2" },
    ],
  },
};

function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Import JSON" dropdown: pick or drop a .json file, or download the sample. */
function ImportMenu({ templates, onImport }: { templates: Template[]; onImport: (r: ImportResult) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as globalThis.Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // Capture phase: the React Flow canvas stops pointer events from bubbling, so a normal listener never hears them.
    addEventListener("pointerdown", away, true);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", away, true); removeEventListener("keydown", esc); };
  }, [open]);

  async function read(f: File | undefined) {
    if (!f || busy) return;
    setProblems([]);
    if (f.size > 1_000_000) { setProblems(["That file is over 1 MB — a sequence JSON is only a few KB."]); return; }
    setBusy(true);
    try {
      // Whole file is validated first, so nothing (no templates) is created from a file with mistakes.
      if (await onImport(parseSequenceJson(await f.text(), templates))) setOpen(false);
    } catch (e) {
      setProblems(importProblems(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div className="relative" ref={box}>
      <button className="btn btn-dark" onClick={() => { setOpen((o) => !o); setProblems([]); }} aria-expanded={open} aria-haspopup="dialog">
        <Upload /> Import JSON <ChevronDown className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="dialog" aria-label="Import sequence from JSON" className="card flex flex-col gap-3"
          // position inline: .card sets position: relative outside Tailwind's layers, which beats the `absolute` utility
          style={{ position: "absolute", right: 0, zIndex: 30, top: "calc(100% + 8px)", width: 380, maxWidth: "calc(100vw - 32px)", boxShadow: "0 18px 50px rgba(0,0,0,.55), inset 0 0 0 1px var(--stroke)" }}>
          <div>
            <h3 className="flex items-center gap-2"><FileBraces width={17} /> Import from JSON</h3>
            <p className="card-sub">Builds the steps — and creates the templates the file defines — then replaces what&apos;s on the canvas. The sequence itself is saved when you click Save.</p>
          </div>
          <label
            className={`tile flex flex-col items-center justify-center gap-1.5 text-center ${busy ? "opacity-60" : "cursor-pointer"}`}
            style={{ padding: "18px 12px", boxShadow: `inset 0 0 0 1px ${drag ? "var(--pink)" : "var(--stroke)"}`, borderStyle: "dashed" }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); read(e.dataTransfer.files[0]); }}>
            {busy ? <Spinner size={20} /> : <Upload width={20} className="text-pink" />}
            <span className="text-[13.5px]">{busy ? "Importing…" : "Choose a JSON file"}</span>
            <small className="text-muted">{busy ? "Creating templates and building the steps" : "or drop it here"}</small>
            <input ref={file} type="file" accept=".json,application/json" className="sr-only" aria-label="JSON file" disabled={busy} onChange={(e) => read(e.target.files?.[0])} />
          </label>
          {problems.length > 0 && (
            <div className="flex flex-col gap-1 text-[12.5px] text-red" role="alert">
              <b className="font-medium">Couldn&apos;t import this file:</b>
              <ul className="list-disc pl-4 flex flex-col gap-0.5 max-h-40 overflow-y-auto">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          <button className="btn btn-sm btn-dark self-start" onClick={() => download("sequence-sample.json", sampleSequenceJson())}>
            <Download /> Download sample JSON
          </button>
        </div>
      )}
    </div>
  );
}

/** Every {{variable}} the sequence's selected templates use, and the lead-CSV column each one needs. */
function VariablesCard({ nodes, templates }: { nodes: Node[]; templates: Template[] }) {
  const byId = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const used = nodes.filter((n) => n.type === "send").flatMap((n) => {
    const d = n.data as Data;
    return ((d.template_ids as string[]) ?? []).map((id) => byId.get(id)).filter((t): t is Template => !!t)
      .map((template) => ({ template, step: (d.label as string) || "Send Mail" }));
  });
  const vars = sequenceVariables(used);
  const fields = vars.filter((v) => v.kind !== "system");
  const auto = vars.filter((v) => v.kind === "system");
  const cols = csvColumns(vars);
  const nTemplates = new Set(used.map((u) => u.template.id)).size;

  async function copy() {
    try { await navigator.clipboard.writeText(cols.join(",")); toast.ok("CSV columns copied"); } catch { toast.err("Couldn't copy — select the columns and copy them manually"); }
  }

  return (
    <aside className="card" aria-label="All variables">
      <h3 className="flex items-center gap-2"><Braces width={17} /> All variables</h3>
      {nTemplates === 0 ? (
        <p className="card-sub">Pick templates in your Send Mail steps to see the variables they use — and the columns your lead CSV needs.</p>
      ) : (
        <>
          <p className="card-sub">From the {nTemplates} template{nTemplates === 1 ? "" : "s"} in this sequence. Your lead CSV needs these columns:</p>
          <code className="block mt-3 tile text-[12px] break-all" style={{ padding: "8px 10px" }} data-testid="csv-columns">{cols.join(", ")}</code>
          {fields.length === 0 && <p className="text-[12.5px] text-muted mt-2">These templates don&apos;t use any lead variables — just the email column.</p>}
          <ul className="flex flex-col gap-1.5 mt-3 max-h-72 overflow-y-auto pr-1">
            {fields.map((v) => (
              <li key={v.key} className="tile" style={{ padding: "8px 10px" }} data-var={v.name}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="badge b-pink flex-none">{`{{${v.name}}}`}</span>
                  <span className="text-[12px] text-txt-2 truncate-1 min-w-0 flex-1" title={v.columns.join(" + ")}>{v.kind === "research" ? "← filled by Research leads" : `→ ${v.columns.join(" + ")}`}</span>
                  {v.alwaysFallback
                    ? <span className="badge b-gray" title="Every use has a fallback, so leads without it still read fine">optional</span>
                    : <span className="badge b-amber" title="At least one use has no fallback — leads without this value get a blank there">needed</span>}
                </div>
                <div className="text-[11.5px] text-muted mt-1">
                  {v.fallbacks.length > 0 && <>Fallback “{v.fallbacks.join("”, “")}” · </>}
                  {[...new Set(v.uses.map((u) => u.step))].join(", ")}
                </div>
              </li>
            ))}
          </ul>
          {auto.length > 0 && (
            <p className="text-[11.5px] text-muted mt-3">Filled automatically: {auto.map((v) => `{{${v.name}}}`).join(", ")}</p>
          )}
          <div className="flex gap-2 mt-3 flex-wrap">
            <button className="btn btn-sm btn-dark" onClick={copy}><Copy /> Copy columns</button>
            <button className="btn btn-sm btn-dark" onClick={() => download("leads-template.csv", cols.join(",") + "\n", "text/csv")}><Download /> CSV template</button>
          </div>
        </>
      )}
    </aside>
  );
}

function Builder({ seq, templates }: { seq: Sequence; templates: Template[] }) {
  const qc = useQueryClient();
  const { fitView } = useReactFlow();
  const initial = useMemo(() => toFlow(seq.graph), [seq.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [name, setName] = useState(seq.name);
  const [description, setDescription] = useState(seq.description);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const selected = nodes.find((n) => n.selected) ?? null;
  // The id this editor saves to: empty until a new draft's first Save creates the sequence.
  const [savedId, setSavedId] = useState(seq.id);
  const isDraft = !savedId;

  const [fitPending, setFitPending] = useState(false);
  useEffect(() => {
    // Wait until every node now on the canvas has been measured (the imported ones, not the ones they replaced).
    if (!fitPending || !nodes.length || !nodes.every((n) => n.measured?.width && n.measured?.height)) return;
    // Clear the flag in the same frame as the fit: clearing it right away would re-run this effect, and its cleanup
    // would cancel the fit before it happened.
    const frame = requestAnimationFrame(() => { fitView({ padding: 0.15, duration: 300 }); setFitPending(false); });
    return () => cancelAnimationFrame(frame);
  }, [fitPending, nodes, fitView]);

  // Unsaved work: ask before the tab closes or reloads.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function applyImport(r: ImportResult) {
    const hasWork = dirty || !isDraft;
    if (hasWork && !confirmAction("Replace the steps on the canvas with the imported ones?")) return false;

    // Create the templates the file defines (one by one, so a failure says exactly which). If one fails, the ones
    // already created stay and are reused by name when the same file is imported again — never duplicated.
    const createdIds: string[] = [];
    for (const t of r.newTemplates) {
      try {
        const made = await post<Template>("/templates", t);
        createdIds.push(made.id);
        qc.setQueryData<Template[]>(["templates"], (old) => [made, ...(old ?? [])]);
      } catch (e) {
        qc.invalidateQueries({ queryKey: ["templates"] });
        throw new Error(`Couldn't create template “${t.name}” — ${(e as Error).message}. Import again to retry; templates already created will be reused.`);
      }
    }
    if (createdIds.length) qc.invalidateQueries({ queryKey: ["templates"] });

    const flow = toFlow(resolvePending(r.graph, createdIds));
    setNodes(flow.nodes);
    setEdges(flow.edges);
    if (r.name) setName(r.name);
    if (r.description !== null) setDescription(r.description);
    setErrors([]);
    setWarnings(r.warnings);
    setDirty(true);
    setFitPending(true); // zoom to the whole imported sequence once React Flow has measured the new nodes
    const steps = flow.nodes.length - 1;
    const made = createdIds.length ? ` and created ${createdIds.length} template${createdIds.length === 1 ? "" : "s"}` : "";
    const kept = r.reused.length ? ` (${r.reused.length} already existed — kept yours)` : "";
    if (r.warnings.length) toast.info(`Imported ${steps} steps${made}${kept} — check the notes above the canvas`);
    else toast.ok(`Imported ${steps} steps${made}${kept} — click Save to keep the sequence`);
    return true;
  }

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => {
      // one outgoing edge per source handle
      const filtered = eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
      return addEdge({ ...c, id: `e-${Date.now()}`, animated: true, label: c.sourceHandle === "no" ? "No" : c.sourceHandle === "yes" ? "Yes" : undefined }, filtered);
    });
    setDirty(true);
  }, [setEdges]);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, description, graph: fromFlow(nodes, edges) };
      // A new sequence only exists once it's saved the first time; the PUT that follows returns validation errors.
      const id = savedId || (await post<Sequence>("/sequences", body)).id;
      setSavedId(id); // even if the PUT below fails, never create a second copy on retry
      return put<{ sequence: Sequence; errors: string[] }>(`/sequences/${id}`, body);
    },
    onSuccess: (r) => {
      setErrors(r.errors);
      setWarnings([]);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["sequences"] });
      qc.setQueryData(["sequence", r.sequence.id], r.sequence);
      const created = !location.pathname.endsWith(`/${r.sequence.id}`);
      // Same page, now backed by the saved sequence (query seeded above so nothing reloads): just fix the URL.
      if (created) window.history.replaceState(null, "", `/sequences/${r.sequence.id}`);
      if (r.errors.length) toast.info("Saved — fix the highlighted issues before launching");
      else toast.ok(created ? "Sequence created" : "Sequence saved");
    },
    onError: toast.err,
  });

  function add(kind: NodeKind) {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const data: Data = kind === "send" ? { label: "Send Mail", template_ids: [], same_thread: true } : kind === "wait" ? { label: "Wait", days: 2, hours: 0, minutes: 0, working_days_only: true } : { label: "Opened?", check: "opened" };
    const last = selected ?? nodes[nodes.length - 1];
    const position = last ? { x: last.position.x + 300, y: last.position.y } : screenToFlowPosition({ x: 400, y: 300 });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: kind, position, data, selected: true }]);
    if (last && !edges.some((e) => e.source === last.id && !e.sourceHandle) && last.type !== "condition") {
      setEdges((es) => [...es, { id: `e-${Date.now()}`, source: last.id, target: id, animated: true }]);
    }
    setDirty(true);
  }

  return (
    <TemplatesCtx.Provider value={templates}>
      {/* Above the canvas/sidebar (their entrance animation makes them stacking contexts) so the Import dropdown overlays them */}
      <header className="head in" style={{ position: "relative", zIndex: 40 }}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link href="/sequences" className="btn btn-icon btn-dark" aria-label="Back"
            onClick={(e) => { if (dirty && !confirmAction(isDraft ? "Discard this new sequence? It hasn't been saved." : "Leave without saving your changes?")) e.preventDefault(); }}><ArrowLeft /></Link>
          <input className="input" style={{ fontSize: 20, background: "transparent", boxShadow: "none", padding: "4px 6px" }} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Sequence name" />
          {isDraft && <span className="badge b-gray flex-none" title="Nothing is stored until you click Save">Not saved yet</span>}
        </div>
        <div className="flex items-center gap-2">
          <ImportMenu templates={templates} onImport={applyImport} />
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending || (!isDraft && !dirty)}>
            {save.isPending ? <Spinner /> : <><Save /> {isDraft ? "Save sequence" : dirty ? "Save" : "Saved"}</>}
          </button>
        </div>
      </header>

      {errors.length > 0 && (
        <div className="card in" style={{ boxShadow: "inset 0 0 0 1px rgba(255,123,138,.45)", padding: 14 }}>
          {errors.map((e) => <div key={e} className="flex items-center gap-2 text-[13px] text-red"><CircleExclamationPoint width={15} /> {e}</div>)}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="card in" style={{ boxShadow: "inset 0 0 0 1px rgba(245,194,107,.45)", padding: 14 }} role="status">
          {warnings.map((w) => <div key={w} className="flex items-center gap-2 text-[13px] text-amber"><CircleExclamationPoint width={15} className="flex-none" /> {w}</div>)}
        </div>
      )}

      <div className="grid gap-4 in" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", ["--d" as string]: 1 }}>
        <article className="card" style={{ padding: 0, height: "calc(100vh - 230px)", minHeight: 520 }}>
          <div className="absolute z-10 top-3 left-3 flex gap-1.5 flex-wrap">
            <button className="chip" style={{ background: "#0c0a0b" }} onClick={() => add("send")}><Plus width={14} /><span>Send Mail</span></button>
            <button className="chip" style={{ background: "#0c0a0b" }} onClick={() => add("wait")}><Plus width={14} /><span>Wait</span></button>
            <button className="chip" style={{ background: "#0c0a0b" }} onClick={() => add("condition")}><Plus width={14} /><span>Condition</span></button>
          </div>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} forceColorMode="dark"
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeDragStop={() => setDirty(true)} onNodesDelete={() => setDirty(true)} onEdgesDelete={() => setDirty(true)}
            onConnect={onConnect} fitView fitViewOptions={{ padding: 0.25 }} minZoom={0.2} deleteKeyCode={["Backspace", "Delete"]}
            defaultEdgeOptions={{ animated: true }} proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1.2} color="rgba(255,255,255,.08)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(10,8,9,.7)" nodeColor="#6f5868" />
          </ReactFlow>
        </article>
        <div className="flex flex-col gap-4" style={{ alignSelf: "start" }}>
        <aside className="card">
          <h3>Step settings</h3>
          <div className="mt-4">
            <Inspector
              node={selected}
              templates={templates}
              onChange={(d) => { setNodes((ns) => ns.map((n) => (n.id === selected?.id ? { ...n, data: d } : n))); setDirty(true); }}
              onDelete={() => { setNodes((ns) => ns.filter((n) => n.id !== selected?.id)); setEdges((es) => es.filter((e) => e.source !== selected?.id && e.target !== selected?.id)); setDirty(true); }}
            />
          </div>
        </aside>
        <VariablesCard nodes={nodes} templates={templates} />
        </div>
      </div>
    </TemplatesCtx.Provider>
  );
}

export default function SequenceBuilder() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const seq = useQuery({ queryKey: ["sequence", id], queryFn: () => get<Sequence>(`/sequences/${id}`), enabled: !!id && !isNew });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/templates") });
  // Next keeps recently visited pages mounted (hidden) — so every time /sequences/new is shown, start a fresh draft
  // instead of showing the last one (effects re-run when a hidden page becomes visible again).
  const [draft, setDraft] = useState(0);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- runs on mount and on each re-show; that's the reset signal
  useEffect(() => { if (isNew) setDraft((n) => n + 1); }, [isNew]);
  useEffect(() => { if (seq.error) toast.err(seq.error); }, [seq.error]);
  const data = isNew ? DRAFT : seq.data;
  if (!data || !templates.data || (isNew && !draft)) return <Skeleton h={600} />;
  return (
    // Same key when a draft's first Save turns the URL into /sequences/<id>, so the editor isn't remounted.
    <ReactFlowProvider key={`builder-${draft}`}>
      <Builder seq={data} templates={templates.data} />
    </ReactFlowProvider>
  );
}
