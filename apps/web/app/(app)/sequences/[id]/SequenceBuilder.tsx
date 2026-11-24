"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import { ArrowLeft, CircleExclamationPoint, Clock, GitBranch, Mail, Play, Plus, Save, Search, Trash, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { Field, Skeleton, Spinner } from "@/components/ui";
import { get, put } from "@/lib/api";
import type { GraphEdge, GraphNode, NodeKind, Sequence, Template } from "@/lib/types";

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

function ConditionNode({ data, selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Shell kind="condition" selected={selected} title={(data.label as string) || "Condition"}>
        If lead <b className="text-txt">{(data.check as string) ?? "opened"}</b> any previous email
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
      {kind === "condition" && (
        <Field label="Branch when the lead has…" hint="Checked against every email sent to this lead in the campaign so far.">
          <select className="select" value={(d.check as string) ?? "opened"} onChange={(e) => onChange({ ...d, check: e.target.value })}>
            <option value="opened">Opened an email</option>
            <option value="clicked">Clicked a link or button</option>
            <option value="replied">Replied</option>
          </select>
        </Field>
      )}
    </div>
  );
}

function Builder({ seq, templates }: { seq: Sequence; templates: Template[] }) {
  const qc = useQueryClient();
  const initial = useMemo(() => toFlow(seq.graph), [seq.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [name, setName] = useState(seq.name);
  const [errors, setErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const selected = nodes.find((n) => n.selected) ?? null;

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => {
      // one outgoing edge per source handle
      const filtered = eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
      return addEdge({ ...c, id: `e-${Date.now()}`, animated: true, label: c.sourceHandle === "no" ? "No" : c.sourceHandle === "yes" ? "Yes" : undefined }, filtered);
    });
    setDirty(true);
  }, [setEdges]);

  const save = useMutation({
    mutationFn: () => put<{ sequence: Sequence; errors: string[] }>(`/sequences/${seq.id}`, { name, description: seq.description, graph: fromFlow(nodes, edges) }),
    onSuccess: (r) => { setErrors(r.errors); setDirty(false); qc.invalidateQueries({ queryKey: ["sequences"] }); r.errors.length ? toast.info("Saved — fix the highlighted issues before launching") : toast.ok("Sequence saved"); },
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
      <header className="head in">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link href="/sequences" className="btn btn-icon btn-dark" aria-label="Back"><ArrowLeft /></Link>
          <input className="input" style={{ fontSize: 20, background: "transparent", boxShadow: "none", padding: "4px 6px" }} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Sequence name" />
        </div>
        <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : <><Save /> {dirty ? "Save" : "Saved"}</>}</button>
      </header>

      {errors.length > 0 && (
        <div className="card in" style={{ boxShadow: "inset 0 0 0 1px rgba(255,123,138,.45)", padding: 14 }}>
          {errors.map((e) => <div key={e} className="flex items-center gap-2 text-[13px] text-red"><CircleExclamationPoint width={15} /> {e}</div>)}
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
            onConnect={onConnect} fitView fitViewOptions={{ padding: 0.25 }} deleteKeyCode={["Backspace", "Delete"]}
            defaultEdgeOptions={{ animated: true }} proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1.2} color="rgba(255,255,255,.08)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(10,8,9,.7)" nodeColor="#6f5868" />
          </ReactFlow>
        </article>
        <aside className="card" style={{ alignSelf: "start" }}>
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
      </div>
    </TemplatesCtx.Provider>
  );
}

export default function SequenceBuilder() {
  const { id } = useParams<{ id: string }>();
  const seq = useQuery({ queryKey: ["sequence", id], queryFn: () => get<Sequence>(`/sequences/${id}`) });
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/templates") });
  useEffect(() => { if (seq.error) toast.err(seq.error); }, [seq.error]);
  if (!seq.data || !templates.data) return <Skeleton h={600} />;
  return (
    <ReactFlowProvider>
      <Builder seq={seq.data} templates={templates.data} />
    </ReactFlowProvider>
  );
}
