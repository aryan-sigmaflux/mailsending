"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleExclamationPoint, MailCheck, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/toast";
import { Empty, Field, Meter, PageHeader, Spinner, VerifyBadge } from "@/components/ui";
import { get, post } from "@/lib/api";
import { ago, num } from "@/lib/format";
import type { ContactList, VerifyStatus } from "@/lib/types";

interface Result { email: string; status: VerifyStatus; reason: string; syntax_ok: boolean; mx: string[]; disposable: boolean; role: boolean; catch_all: boolean | null; smtp_code: number | null; smtp_message: string | null }

const REASONS: Record<string, string> = {
  mailbox_exists: "The mail server confirmed this mailbox exists.",
  mailbox_not_found: "The mail server says this mailbox does not exist.",
  domain_accepts_all: "The domain accepts every address, so we can't confirm this specific mailbox.",
  role_account: "Mailbox exists but is a shared/role address (info@, sales@…) — lower reply rates.",
  no_mx: "The domain has no MX records — it can't receive email.",
  disposable_domain: "Disposable / temporary email provider.",
  provider_blocks_verification: "This provider blocks verification; treat as risky.",
  greylisted_or_temp_failure: "The server asked us to retry later (greylisting).",
};

function explain(reason: string) {
  if (reason.startsWith("smtp_unreachable")) return "Couldn't reach the mail server on port 25 from this server. Deploy the verifier on a host with outbound port 25 open.";
  if (reason.startsWith("bad_syntax")) return "Not a valid email address.";
  return REASONS[reason] ?? reason;
}

export default function VerifierPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [bulk, setBulk] = useState("");
  const [listId, setListId] = useState("");
  const summary = useQuery({ queryKey: ["verify-summary"], queryFn: () => get<{ by_status: Record<string, number>; credits_left: number; credits_monthly: number }>("/verify/summary") });
  const history = useQuery({ queryKey: ["verify-history"], queryFn: () => get<(Result & { id: string; created_at: string })[]>("/verify/history?limit=50"), refetchInterval: 8000 });
  const lists = useQuery({ queryKey: ["lists"], queryFn: () => get<ContactList[]>("/lists") });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["verify-summary"] }); qc.invalidateQueries({ queryKey: ["verify-history"] }); };

  const one = useMutation({ mutationFn: () => post<Result>("/verify", { email }), onSuccess: refresh, onError: toast.err });
  const many = useMutation({
    mutationFn: () => post<{ queued: number; skipped_no_credits: number }>("/verify/bulk", { emails: bulk.split(/[\s,;]+/).filter(Boolean), list_id: listId || null }),
    onSuccess: (r) => { toast.ok(`Verifying ${r.queued} emails in the background`); setBulk(""); refresh(); },
    onError: toast.err,
  });
  const r = one.data;
  const s = summary.data;

  return (
    <>
      <PageHeader title="Email verifier" sub="Confirm addresses exist before you send — protects your bounce rate and domain reputation" />
      <div className="grid gap-4 in" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <article className="card">
          <h3>Check one address</h3>
          <form className="flex gap-2 mt-4" onSubmit={(e) => { e.preventDefault(); one.mutate(); }}>
            <div className="ask flex-1"><Search /><input placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <button className="btn btn-primary" disabled={one.isPending}>{one.isPending ? <Spinner /> : "Verify"}</button>
          </form>
          {r && (
            <div className="tile mt-4">
              <div className="flex items-center gap-3">
                {r.status === "valid" ? <CircleCheck color="var(--green)" /> : <CircleExclamationPoint color={r.status === "invalid" ? "var(--red)" : "var(--amber)"} />}
                <b className="font-medium flex-1 truncate-1">{r.email}</b>
                <VerifyBadge status={r.status} />
              </div>
              <p className="text-[12.5px] text-txt-2 mt-3">{explain(r.reason)}</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className={`badge ${r.syntax_ok ? "b-green" : "b-red"}`}>Syntax</span>
                <span className={`badge ${r.mx.length ? "b-green" : "b-red"}`}>MX {r.mx[0] ?? ""}</span>
                <span className={`badge ${r.disposable ? "b-red" : "b-green"}`}>{r.disposable ? "Disposable" : "Not disposable"}</span>
                <span className={`badge ${r.role ? "b-amber" : "b-green"}`}>{r.role ? "Role address" : "Personal"}</span>
                {r.catch_all != null && <span className={`badge ${r.catch_all ? "b-amber" : "b-green"}`}>{r.catch_all ? "Catch-all" : "Not catch-all"}</span>}
                {r.smtp_code && <span className="badge b-gray">SMTP {r.smtp_code}</span>}
              </div>
            </div>
          )}
        </article>

        <article className="card">
          <h3>Bulk verify</h3>
          <div className="flex flex-col gap-3 mt-4">
            <Field label="Verify a whole lead list">
              <select className="select" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">— Paste emails instead —</option>
                {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({num(l.contact_count)})</option>)}
              </select>
            </Field>
            {!listId && <Field label="Emails (one per line, or comma separated)"><textarea className="textarea" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"asha@acme.in\nravi@beta.in"} /></Field>}
            <button className="btn btn-primary self-end" disabled={many.isPending || (!listId && !bulk.trim())} onClick={() => many.mutate()}>{many.isPending ? <Spinner /> : <><MailCheck /> Start verification</>}</button>
          </div>
        </article>

        <article className="card glow">
          <h3>Credits</h3>
          <div className="text-[30px] font-medium mt-4">{num(s?.credits_left)}<span className="text-[14px] text-muted font-light"> / {num(s?.credits_monthly)} this month</span></div>
          <div className="mt-3"><Meter value={(s?.credits_monthly ?? 0) - (s?.credits_left ?? 0)} max={s?.credits_monthly ?? 1} /></div>
          <div className="grid grid-cols-2 gap-2 mt-5 text-[12.5px]">
            {(["valid", "invalid", "catch_all", "risky", "unknown"] as VerifyStatus[]).map((k) => (
              <div key={k} className="flex items-center justify-between"><VerifyBadge status={k} /><span>{num(s?.by_status[k])}</span></div>
            ))}
          </div>
        </article>
      </div>

      <article className="card in">
        <h3>Recent checks</h3>
        {!history.data?.length ? <Empty icon={<MailCheck />} title="No checks yet" /> : (
          <div className="overflow-x-auto mt-3">
            <table className="table">
              <thead><tr><th>Email</th><th>Result</th><th>Reason</th><th>When</th></tr></thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={h.id}><td>{h.email}</td><td><VerifyBadge status={h.status} /></td><td className="text-txt-2 text-[12.5px]">{explain(h.reason)}</td><td className="text-muted text-[12px]">{ago(h.created_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </>
  );
}
