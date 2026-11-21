"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CircleCheck, CircleExclamationPoint, KeyRound, Plus, RefreshCw, Sparkles, Trash } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, Modal, PageHeader, Spinner, confirmAction } from "@/components/ui";
import { del, get, patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TIMEZONES, num } from "@/lib/format";
import type { Integration } from "@/lib/types";

const AI_PROVIDERS = [
  { id: "openai", label: "OpenAI", model: "gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic (Claude)", model: "claude-sonnet-5-5" },
  { id: "gemini", label: "Google Gemini", model: "gemini-2.5-flash" },
  { id: "openrouter", label: "OpenRouter", model: "openai/gpt-4o-mini" },
  { id: "custom", label: "Custom (OpenAI-compatible)", model: "" },
];

function AddIntegration({ kind, open, onClose }: { kind: "ai" | "apollo"; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState(kind === "ai" ? "openai" : "apollo");
  const [mode, setMode] = useState<"api" | "mcp">("api");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const add = useMutation({
    mutationFn: () => post<Integration>("/integrations", {
      kind, provider: kind === "apollo" ? "apollo" : provider, mode, api_key: key || null,
      config: kind === "ai" ? { model, ...(provider === "custom" ? { base_url: baseUrl } : {}) } : mode === "mcp" ? { mcp_url: mcpUrl } : {},
    }),
    onSuccess: async (i) => { qc.invalidateQueries({ queryKey: ["integrations"] }); onClose(); const t = await post<Integration>(`/integrations/${i.id}/test`); qc.invalidateQueries({ queryKey: ["integrations"] }); t.last_test_ok ? toast.ok(t.last_test_message ?? "Connected") : toast.err(t.last_test_message ?? "Test failed"); },
    onError: toast.err,
  });
  return (
    <Modal open={open} onClose={onClose} title={kind === "ai" ? "Connect an AI provider" : "Connect Apollo"} sub="Keys are encrypted at rest and only used for your workspace."
      footer={<><button className="btn btn-dark" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={add.isPending || (mode === "api" && !key)} onClick={() => add.mutate()}>{add.isPending ? <Spinner /> : "Connect & test"}</button></>}>
      <div className="flex flex-col gap-4">
        {kind === "ai" ? (
          <>
            <Field label="Provider"><select className="select" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(AI_PROVIDERS.find((p) => p.id === e.target.value)?.model ?? ""); }}>{AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
            {provider === "custom" && <Field label="Base URL" hint="Any OpenAI-compatible endpoint, e.g. https://api.together.xyz/v1"><input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>}
            <Field label="Model" hint="Use a web-search-capable model if you'll use research variables later."><input className="input" value={model} onChange={(e) => setModel(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="Connection type">
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value as "api" | "mcp")}><option value="api">Apollo API key</option><option value="mcp">Apollo MCP server</option></select>
          </Field>
        )}
        {mode === "mcp" && <Field label="MCP server URL"><input className="input" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://…" /></Field>}
        <Field label={mode === "mcp" ? "Auth token (optional)" : "API key"}><input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>
      </div>
    </Modal>
  );
}

export default function SettingsPage() {
  const { me, load } = useAuth();
  const qc = useQueryClient();
  const user = me!.user;
  const usage = me!.usage;
  const [name, setName] = useState(user.full_name);
  const [tz, setTz] = useState(user.timezone);
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const [adding, setAdding] = useState<"ai" | "apollo" | null>(null);
  const integ = useQuery({ queryKey: ["integrations"], queryFn: () => get<Integration[]>("/integrations") });
  const profile = useMutation({ mutationFn: () => patch("/auth/me", { full_name: name, timezone: tz }), onSuccess: () => { toast.ok("Profile saved"); load(); }, onError: toast.err });
  const password = useMutation({ mutationFn: () => post("/auth/password", pw), onSuccess: () => { toast.ok("Password changed"); setPw({ current_password: "", new_password: "" }); }, onError: toast.err });
  const test = useMutation({ mutationFn: (id: string) => post<Integration>(`/integrations/${id}/test`), onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["integrations"] }); t.last_test_ok ? toast.ok(t.last_test_message ?? "OK") : toast.err(t.last_test_message ?? "Failed"); }, onError: toast.err });
  const remove = useMutation({ mutationFn: (id: string) => del(`/integrations/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }), onError: toast.err });

  const limits: [string, number, number][] = [
    ["Emails today", usage.emails_today, user.max_daily_emails], ["Emails this month", usage.emails_month, user.max_monthly_emails],
    ["Mailboxes", usage.mailboxes, user.max_mailboxes], ["Domains", usage.domains, user.max_domains],
    ["Active campaigns", usage.active_campaigns, user.max_campaigns], ["Contacts", usage.contacts, user.max_contacts],
    ["Verifications this month", usage.verifications_month, user.verify_credits_monthly],
  ];

  const section = (kind: "ai" | "apollo") => {
    const rows = integ.data?.filter((i) => i.kind === kind) ?? [];
    const allowed = user.role === "super_admin" || user.features[kind];
    return (
      <article className="card">
        <div className="flex items-center justify-between">
          <div><h3 className="flex items-center gap-2">{kind === "ai" ? <Bot width={18} /> : <Sparkles width={18} />} {kind === "ai" ? "AI providers" : "Apollo"}</h3>
            <p className="card-sub">{kind === "ai" ? "Bring your own key — OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible API." : "Connect your Apollo API key or MCP server to find and enrich leads."}</p></div>
          {allowed && <button className="btn btn-sm btn-ghost" onClick={() => setAdding(kind)}><Plus /> Connect</button>}
        </div>
        {!allowed ? <p className="badge b-amber mt-4">Not enabled on your plan — ask your admin.</p> : !rows.length ? <Empty title="Nothing connected yet" /> : (
          <ul className="rowlist mt-2">
            {rows.map((i) => (
              <li key={i.id}>
                {i.last_test_ok ? <CircleCheck color="var(--green)" width={18} /> : i.last_test_ok === false ? <CircleExclamationPoint color="var(--red)" width={18} /> : <KeyRound width={18} />}
                <div className="min-w-0">
                  <b className="font-normal text-[13.5px] flex items-center gap-2">{i.label}{i.is_default && <span className="badge b-pink">default</span>}<span className="badge b-gray">{i.mode.toUpperCase()}</span></b>
                  <small className="block text-[11.5px] text-muted truncate-1">{i.key_hint || "no key"}{i.config.model ? ` · ${i.config.model}` : ""}{i.last_test_message ? ` · ${i.last_test_message}` : ""}</small>
                </div>
                <div className="flex gap-1.5">
                  <button className="btn btn-icon btn-sm btn-dark" title="Test" onClick={() => test.mutate(i.id)} disabled={test.isPending && test.variables === i.id}>{test.isPending && test.variables === i.id ? <Spinner size={14} /> : <RefreshCw />}</button>
                  <button className="btn btn-icon btn-sm btn-danger" title="Remove" onClick={() => confirmAction(`Remove ${i.label}?`) && remove.mutate(i.id)}><Trash /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  };

  return (
    <>
      <PageHeader title="Settings" sub={user.email} />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <div className="flex flex-col gap-4">
          <article className="card">
            <h3>Profile</h3>
            <div className="flex flex-col gap-4 mt-4">
              <Field label="Full name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Time zone"><select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</select></Field>
              <button className="btn btn-primary self-end" onClick={() => profile.mutate()} disabled={profile.isPending}>Save profile</button>
            </div>
          </article>
          <article className="card">
            <h3>Password</h3>
            <div className="flex flex-col gap-4 mt-4">
              <Field label="Current password"><input className="input" type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
              <Field label="New password" hint="At least 8 characters"><input className="input" type="password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
              <button className="btn btn-ghost self-end" onClick={() => password.mutate()} disabled={password.isPending || pw.new_password.length < 8}>Change password</button>
            </div>
          </article>
        </div>
        <div className="flex flex-col gap-4">
          {section("ai")}
          {section("apollo")}
        </div>
        <article className="card glow">
          <h3>Your plan & usage</h3>
          <p className="card-sub">Limits are set by your administrator{user.expires_at ? ` · account valid until ${new Date(user.expires_at).toLocaleDateString()}` : ""}.</p>
          <div className="flex flex-col gap-4 mt-5">
            {limits.map(([l, v, m]) => (
              <div key={l}><div className="flex justify-between text-[12.5px] mb-1.5"><span className="text-txt-2">{l}</span><span>{num(v)} / {num(m)}</span></div><Meter value={v} max={m} tone={v >= m ? "red" : v / m > 0.8 ? "amber" : "pink"} /></div>
            ))}
          </div>
        </article>
      </div>
      {adding && <AddIntegration key={adding} kind={adding} open onClose={() => setAdding(null)} />}
    </>
  );
}
