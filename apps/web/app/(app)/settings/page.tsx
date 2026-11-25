"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ChartLine, CircleCheck, CircleExclamationPoint, Gauge, KeyRound, Plus, RefreshCw, Sparkles, Trash } from "lucide-react";
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

type Kind = Integration["kind"];

const LOCATIONS: [number, string][] = [
  [2840, "United States"], [2356, "India"], [2826, "United Kingdom"], [2124, "Canada"], [2036, "Australia"], [2276, "Germany"],
  [2250, "France"], [2784, "United Arab Emirates"], [2702, "Singapore"], [2554, "New Zealand"], [2372, "Ireland"], [2528, "Netherlands"],
  [2724, "Spain"], [2380, "Italy"], [2076, "Brazil"], [2484, "Mexico"], [2710, "South Africa"], [2682, "Saudi Arabia"],
];
const LANGUAGES: [string, string][] = [["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["ja", "Japanese"], ["ar", "Arabic"], ["hi", "Hindi"]];

async function connectAndTest(qc: ReturnType<typeof useQueryClient>, body: unknown, onClose: () => void) {
  const i = await post<Integration>("/integrations", body);
  qc.invalidateQueries({ queryKey: ["integrations"] });
  onClose();
  toast.info("Connected — running a test lookup…");
  const t = await post<Integration>(`/integrations/${i.id}/test`);
  qc.invalidateQueries({ queryKey: ["integrations"] });
  if (t.last_test_ok) toast.ok(t.last_test_message ?? "Connected");
  else toast.err(t.last_test_message ?? "Test failed");
}

/** Keyword data (search volume + bids) for Research leads: Google Ads Keyword Planner or DataForSEO. */
function AddKeywordSource({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<"google_ads" | "dataforseo">("google_ads");
  const [auth, setAuth] = useState<"service_account" | "oauth">("service_account");
  const [f, setF] = useState({ service_account: "", client_id: "", client_secret: "", refresh_token: "", developer_token: "", customer_id: "", login_customer_id: "", login: "", password: "", location_code: 2840, language_code: "en" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: k === "location_code" ? +e.target.value : e.target.value });
  const saEmail = (() => { try { return (JSON.parse(f.service_account) as { client_email?: string }).client_email ?? ""; } catch { return ""; } })();
  const ready = provider === "dataforseo" ? !!(f.login && f.password)
    : !!f.customer_id && (auth === "service_account" ? !!saEmail : !!(f.client_id && f.client_secret && f.refresh_token));
  const add = useMutation({
    mutationFn: () => connectAndTest(qc, provider === "google_ads"
      ? {
          kind: "keywords", provider,
          secrets: auth === "service_account"
            ? { service_account: f.service_account, developer_token: f.developer_token }
            : { client_secret: f.client_secret, refresh_token: f.refresh_token, developer_token: f.developer_token },
          config: { auth, ...(auth === "oauth" ? { client_id: f.client_id } : { service_account_email: saEmail }), customer_id: f.customer_id, login_customer_id: f.login_customer_id, location_code: f.location_code, language_code: f.language_code },
        }
      : { kind: "keywords", provider, api_key: f.password, config: { login: f.login, location_code: f.location_code, language_code: f.language_code } }, onClose),
    onError: toast.err,
  });
  async function loadKey(file: File) {
    setF((x) => ({ ...x, service_account: "" }));
    const text = await file.text();
    setF((x) => ({ ...x, service_account: text }));
  }
  return (
    <Modal open onClose={onClose} wide title="Connect keyword data" sub="Search volume, competition and top-of-page bids for the keywords Research leads finds. Encrypted at rest."
      footer={<><button className="btn btn-dark" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={add.isPending || !ready} onClick={() => add.mutate()}>{add.isPending ? <Spinner /> : "Connect & test"}</button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Source">
          <select className="select" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            <option value="google_ads">Google Ads API — Keyword Planner (free, needs Basic API access)</option>
            <option value="dataforseo">DataForSEO — same Keyword Planner data, pay per lookup</option>
          </select>
        </Field>
        {provider === "google_ads" ? (
          <>
            <p className="tile text-[12.5px] text-txt-2" style={{ padding: "10px 12px" }}>
              Needs a Google Cloud project with <b>Basic</b> (or Standard) Google Ads API access — Explorer access can&apos;t use Keyword Planner.
              Step-by-step setup: deploy/DEPLOY.md → &ldquo;Research leads: keyword data&rdquo;.
            </p>
            <Field label="Sign in with">
              <select className="select" value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
                <option value="service_account">Service account key (recommended — no tokens to refresh)</option>
                <option value="oauth">OAuth client + refresh token</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {auth === "service_account" ? (
                <Field label="Service account JSON key" className="col-span-2"
                  hint={saEmail ? <>Add <b className="text-txt">{saEmail}</b> as a user in Google Ads (Admin → Access and security) before testing.</> : "The .json file you downloaded from Google Cloud → IAM → Service accounts → Keys."}>
                  <input type="file" accept=".json,application/json" className="input" style={{ paddingTop: 8 }} onChange={(e) => e.target.files?.[0] && loadKey(e.target.files[0])} />
                  <textarea className="textarea" rows={3} placeholder='…or paste it: { "type": "service_account", … }' value={f.service_account} onChange={set("service_account")} spellCheck={false} style={{ fontFamily: "monospace", fontSize: 11.5 }} />
                </Field>
              ) : (
                <>
                  <Field label="OAuth client ID"><input className="input" value={f.client_id} onChange={set("client_id")} autoComplete="off" /></Field>
                  <Field label="OAuth client secret"><input className="input" type="password" value={f.client_secret} onChange={set("client_secret")} autoComplete="off" /></Field>
                  <Field label="Refresh token" className="col-span-2" hint="For the https://www.googleapis.com/auth/adwords scope"><input className="input" type="password" value={f.refresh_token} onChange={set("refresh_token")} autoComplete="off" /></Field>
                </>
              )}
              <Field label="Google Ads customer ID" hint="The Ads account to plan with, e.g. 123-456-7890 (top right in Google Ads)"><input className="input" value={f.customer_id} onChange={set("customer_id")} /></Field>
              <Field label="Manager (MCC) ID" hint="Only if access goes through a manager account"><input className="input" value={f.login_customer_id} onChange={set("login_customer_id")} /></Field>
              <Field label="Developer token (optional)" hint="Ignored by Google since Sept 2026; only for older setups" className="col-span-2"><input className="input" type="password" value={f.developer_token} onChange={set("developer_token")} autoComplete="off" /></Field>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="API login (email)"><input className="input" value={f.login} onChange={set("login")} autoComplete="off" /></Field>
            <Field label="API password" hint="From app.dataforseo.com → API access"><input className="input" type="password" value={f.password} onChange={set("password")} autoComplete="off" /></Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default location" hint="Leads with a known country use that country instead"><select className="select" value={f.location_code} onChange={set("location_code")}>{LOCATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Language"><select className="select" value={f.language_code} onChange={set("language_code")}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        </div>
      </div>
    </Modal>
  );
}

function AddPageSpeed({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const add = useMutation({ mutationFn: () => connectAndTest(qc, { kind: "pagespeed", provider: "google", api_key: key || null }, onClose), onError: toast.err });
  return (
    <Modal open onClose={onClose} title="Google PageSpeed" sub="Optional: adds a mobile performance score (Core Web Vitals) to website research."
      footer={<><button className="btn btn-dark" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={add.isPending} onClick={() => add.mutate()}>{add.isPending ? <Spinner /> : "Save & test"}</button></>}>
      <Field label="PageSpeed Insights API key" hint="Free from Google Cloud → APIs → PageSpeed Insights API. Without a key Google allows only a handful of tests.">
        <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      </Field>
    </Modal>
  );
}

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
  const [adding, setAdding] = useState<Kind | null>(null);
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

  const SECTIONS: Record<Kind, [React.ReactNode, string, string]> = {
    ai: [<Bot key="i" width={18} />, "AI providers", "Bring your own key — OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible API. Research leads also uses it to find each lead's product keywords."],
    apollo: [<Sparkles key="i" width={18} />, "Apollo", "Connect your Apollo API key or MCP server to find and enrich leads."],
    keywords: [<ChartLine key="i" width={18} />, "Keyword data", "Search volume and bids for Research leads — Google Ads Keyword Planner or DataForSEO."],
    pagespeed: [<Gauge key="i" width={18} />, "PageSpeed (optional)", "Mobile performance scores in website audits."],
  };
  const section = (kind: Kind) => {
    const rows = integ.data?.filter((i) => i.kind === kind) ?? [];
    const allowed = kind === "keywords" || kind === "pagespeed" || user.role === "super_admin" || user.features[kind];
    const [icon, title, sub] = SECTIONS[kind];
    return (
      <article className="card">
        <div className="flex items-center justify-between">
          <div><h3 className="flex items-center gap-2">{icon} {title}</h3>
            <p className="card-sub">{sub}</p></div>
          {allowed && <button className="btn btn-sm btn-ghost" onClick={() => setAdding(kind)}><Plus /> Connect</button>}
        </div>
        {!allowed ? <p className="badge b-amber mt-4">Not enabled on your plan — ask your admin.</p> : !rows.length ? <Empty title="Nothing connected yet" /> : (
          <ul className="rowlist mt-2">
            {rows.map((i) => (
              <li key={i.id}>
                {i.last_test_ok ? <CircleCheck color="var(--green)" width={18} /> : i.last_test_ok === false ? <CircleExclamationPoint color="var(--red)" width={18} /> : <KeyRound width={18} />}
                <div className="min-w-0">
                  <b className="font-normal text-[13.5px] flex items-center gap-2">{i.label}{i.is_default && <span className="badge b-pink">default</span>}<span className="badge b-gray">{i.mode.toUpperCase()}</span></b>
                  <small className="block text-[11.5px] text-muted truncate-1" title={i.last_test_message ?? ""}>{i.key_hint || "no key"}{i.config.model ? ` · ${i.config.model}` : ""}{i.config.customer_id ? ` · customer ${i.config.customer_id}` : ""}{i.config.currency ? ` · ${i.config.currency}` : ""}{i.last_test_message ? ` · ${i.last_test_message}` : ""}</small>
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
          {section("keywords")}
          {section("pagespeed")}
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
      {(adding === "ai" || adding === "apollo") && <AddIntegration key={adding} kind={adding} open onClose={() => setAdding(null)} />}
      {adding === "keywords" && <AddKeywordSource onClose={() => setAdding(null)} />}
      {adding === "pagespeed" && <AddPageSpeed onClose={() => setAdding(null)} />}
    </>
  );
}
