/**
 * Sequence import format (version 1).
 *
 * A readable list of steps instead of the canvas's raw nodes/edges, plus the templates those steps send.
 * Steps run top to bottom; a condition ends its list and continues inside its "yes" / "no" branches
 * (step lists themselves, nested as deep as needed).
 *
 * {
 *   "name": "Cold outreach",                      optional
 *   "description": "…",                           optional
 *   "templates": [                                optional — created on import if your account doesn't have them
 *     { "name": "Intro", "subject": "Quick question, {{FirstName|there}}", "body": "Hi {{FirstName|there}},\n\n…" }
 *   ],
 *   "steps": [
 *     { "type": "email", "label": "Intro", "templates": ["Intro"], "same_thread": true },
 *     { "type": "wait", "days": 2, "hours": 0, "minutes": 0, "working_days_only": true },
 *     { "type": "condition", "label": "Opened?", "check": "opened" | "clicked" | "replied",
 *       "yes": [ …steps ], "no": [ …steps ] }
 *   ]
 * }
 *
 * An email step's "templates" entries are template names (or IDs) — or a full template object, defined inline.
 * A name that already exists in the account is reused as-is (never overwritten, never duplicated); a name defined in
 * the file but not in the account is created; a name that's neither leaves the step without it, with a warning.
 */
import type { GraphEdge, GraphNode, Sequence, Template } from "@/lib/types";

export const SEQUENCE_JSON_VERSION = 1;
const MAX_STEPS = 100;
const MAX_TEMPLATES = 50;
const COL = 300; // canvas spacing between steps
const ROW = 170; // vertical spacing between branches
export const PENDING = "pending:"; // template_ids prefix for templates the import still has to create

type Json = Record<string, unknown>;
/** A template the import will create (body already converted to HTML). */
export interface TemplateDraft { name: string; subject: string; body_html: string; track_opens: boolean; track_clicks: boolean }
export interface ImportResult {
  name: string | null;
  description: string | null;
  /** Send nodes reference new templates as `pending:<index into newTemplates>` until they're created. */
  graph: Sequence["graph"];
  newTemplates: TemplateDraft[];
  /** Names defined in the file that the account already had — those are used instead (not overwritten). */
  reused: string[];
  warnings: string[];
}

class ImportError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (name: string) => name.trim().toLowerCase();
const TYPE_ALIASES: Record<string, "send" | "wait" | "condition"> = {
  email: "send", send: "send", send_mail: "send", mail: "send", wait: "wait", delay: "wait", condition: "condition", if: "condition",
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text → paragraphs (blank line = new paragraph, single newline = line break). HTML is kept as written. */
export function bodyToHtml(body: string): string {
  if (/<\/?[a-z][^>]*>/i.test(body)) return body;
  return body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Rows a step list needs on the canvas (each condition stacks its two branches). */
function rows(steps: unknown[]): number {
  const last = steps[steps.length - 1];
  if (isObj(last) && TYPE_ALIASES[String(last.type ?? "").toLowerCase()] === "condition") {
    return Math.max(1, rows(Array.isArray(last.yes) ? last.yes : [])) + Math.max(1, rows(Array.isArray(last.no) ? last.no : []));
  }
  return 1;
}

export function parseSequenceJson(text: string, templates: Template[]): ImportResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ImportError([`This isn't valid JSON — ${(e as Error).message}`]);
  }
  // Also accept a bare array of steps.
  if (Array.isArray(doc)) doc = { steps: doc };
  if (!isObj(doc)) throw new ImportError(["The file must be a JSON object with a \"steps\" list (see the sample)."]);
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) throw new ImportError(["Add a \"steps\" list with at least one step (see the sample)."]);

  const problems: string[] = [];
  const warnings: string[] = [];
  const missing = new Set<string>();
  const existing = new Map<string, Template>();
  for (const t of templates) if (!existing.has(key(t.name))) existing.set(key(t.name), t); // list is newest first
  const newTemplates: TemplateDraft[] = [];
  const pendingByName = new Map<string, number>(); // name key -> index in newTemplates
  const definedInFile = new Set<string>();
  const reused = new Set<string>();

  /** Validates a template object; returns its name key (creating a draft for it if the account doesn't have it). */
  function define(raw: Json, path: string): string | null {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) { problems.push(`${path}: a template needs a "name"`); return null; }
    if (name.length > 200) { problems.push(`${path}: template name is longer than 200 characters`); return null; }
    if (definedInFile.has(key(name))) { problems.push(`${path}: template “${name}” is defined twice in this file`); return null; }
    definedInFile.add(key(name));
    const subject = raw.subject ?? "";
    const body = raw.body ?? raw.body_html ?? "";
    if (typeof subject !== "string") problems.push(`${path}: "subject" must be text (use "" for an in-thread follow-up)`);
    if (typeof body !== "string") problems.push(`${path}: "body" must be text or HTML`);
    for (const k of ["track_opens", "track_clicks"]) if (raw[k] !== undefined && typeof raw[k] !== "boolean") problems.push(`${path}: "${k}" must be true or false`);
    if (existing.has(key(name))) { reused.add(existing.get(key(name))!.name); return key(name); }
    if (definedInFile.size > MAX_TEMPLATES) { if (definedInFile.size === MAX_TEMPLATES + 1) problems.push(`A file can define at most ${MAX_TEMPLATES} templates`); return null; }
    pendingByName.set(key(name), newTemplates.length);
    newTemplates.push({
      name, subject: typeof subject === "string" ? subject.slice(0, 500) : "", body_html: typeof body === "string" ? bodyToHtml(body) : "",
      track_opens: raw.track_opens !== false, track_clicks: raw.track_clicks !== false,
    });
    return key(name);
  }

  if (doc.templates !== undefined) {
    if (!Array.isArray(doc.templates)) problems.push(`"templates" must be a list of {"name", "subject", "body"} objects`);
    else doc.templates.forEach((t, i) => (isObj(t) ? define(t, `templates[${i}]`) : problems.push(`templates[${i}]: must be an object with "name", "subject" and "body"`)));
  }

  /** A step's template reference → template id (existing), pending id (created by this import), or null (missing). */
  function resolve(ref: unknown, path: string): string | null {
    if (isObj(ref)) {
      const k = define(ref, path);
      if (!k) return null;
      return existing.has(k) ? existing.get(k)!.id : `${PENDING}${pendingByName.get(k)}`;
    }
    if (typeof ref !== "string" || !ref.trim()) { problems.push(`${path}: template references must be a name, an ID or a template object`); return null; }
    const byId = templates.find((x) => x.id === ref.trim());
    if (byId) return byId.id;
    const k = key(ref);
    if (existing.has(k)) return existing.get(k)!.id;
    if (pendingByName.has(k)) return `${PENDING}${pendingByName.get(k)}`;
    missing.add(ref.trim());
    return null;
  }

  const nodes: GraphNode[] = [{ id: "start", type: "start", position: { x: 80, y: 0 }, data: { label: "Start" } }];
  const edges: GraphEdge[] = [];
  const counters = { send: 0, wait: 0, condition: 0 };
  let total = 0;
  const link = (source: string, target: string, handle?: "yes" | "no") =>
    edges.push({ id: `e${edges.length + 1}`, source, target, sourceHandle: handle ?? null });

  function num(step: Json, k: string, path: string): number {
    const v = step[k];
    if (v === undefined || v === null || v === "") return 0;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      problems.push(`${path}: "${k}" must be a whole number of 0 or more`);
      return 0;
    }
    return n;
  }

  /** Lays out a step list starting after `prev` (connected via `handle`), at column `col`, centred on `y`. */
  function walk(steps: unknown[], path: string, prev: string, handle: "yes" | "no" | undefined, col: number, y: number) {
    steps.forEach((raw, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(raw)) { problems.push(`${p}: each step must be an object like {"type": "email", …}`); return; }
      const kind = TYPE_ALIASES[String(raw.type ?? "").toLowerCase()];
      if (!kind) { problems.push(`${p}: "type" must be "email", "wait" or "condition" (got ${JSON.stringify(raw.type ?? null)})`); return; }
      if (++total > MAX_STEPS) { if (total === MAX_STEPS + 1) problems.push(`A sequence can have at most ${MAX_STEPS} steps`); return; }
      const n = ++counters[kind];
      const id = `${kind === "send" ? "send" : kind === "wait" ? "wait" : "cond"}-${n}`;
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : null;
      const position = { x: 80 + (col + i + 1) * COL, y };
      let data: Json;

      if (kind === "send") {
        const refs = Array.isArray(raw.templates) ? raw.templates : raw.template !== undefined ? [raw.template] : [];
        if (!refs.length) problems.push(`${p}: an email step needs "templates": ["Template name", …]`);
        const ids: string[] = [];
        refs.forEach((ref, j) => {
          const tid = resolve(ref, `${p}.templates[${j}]`);
          if (tid && !ids.includes(tid)) ids.push(tid);
        });
        if (raw.same_thread !== undefined && typeof raw.same_thread !== "boolean") problems.push(`${p}: "same_thread" must be true or false`);
        data = { label: label ?? `Email ${n}`, template_ids: ids, same_thread: raw.same_thread !== false };
      } else if (kind === "wait") {
        const days = num(raw, "days", p), hours = num(raw, "hours", p), minutes = num(raw, "minutes", p);
        if (days * 1440 + hours * 60 + minutes <= 0) problems.push(`${p}: a wait needs "days", "hours" or "minutes" greater than 0`);
        if (raw.working_days_only !== undefined && typeof raw.working_days_only !== "boolean") problems.push(`${p}: "working_days_only" must be true or false`);
        data = { label: label ?? "Wait", days, hours, minutes, working_days_only: raw.working_days_only === true };
      } else {
        const check = String(raw.check ?? "").toLowerCase();
        if (!["opened", "clicked", "replied"].includes(check)) problems.push(`${p}: "check" must be "opened", "clicked" or "replied"`);
        if (i !== steps.length - 1) problems.push(`${p}: a condition must be the last step in its list — put the steps after it inside its "yes" / "no" lists`);
        data = { label: label ?? `${check ? check[0].toUpperCase() + check.slice(1) : "Opened"}?`, check: check || "opened" };
      }

      nodes.push({ id, type: kind, position, data });
      link(prev, id, i === 0 ? handle : undefined);
      prev = id;

      if (kind === "condition") {
        const yes = raw.yes === undefined ? [] : raw.yes, no = raw.no === undefined ? [] : raw.no;
        if (!Array.isArray(yes) || !Array.isArray(no)) { problems.push(`${p}: "yes" and "no" must be lists of steps`); return; }
        if (!yes.length && !no.length) warnings.push(`${label ?? "A condition"} has no steps in "yes" or "no" — leads stop there`);
        const ry = Math.max(1, rows(yes)), rn = Math.max(1, rows(no));
        walk(yes, `${p}.yes`, id, "yes", col + i + 1, y - (rn * ROW) / 2);
        walk(no, `${p}.no`, id, "no", col + i + 1, y + (ry * ROW) / 2);
      }
    });
  }

  walk(doc.steps, "steps", "start", undefined, 0, 0);
  if (problems.length) throw new ImportError(problems);
  if (missing.size) {
    const list = [...missing].map((m) => `“${m}”`).join(", ");
    warnings.unshift(`No template named ${list} in your account or in the file's "templates" list — add ${missing.size === 1 ? "it" : "them"} to "templates" (see the sample) and import again, or pick ${missing.size === 1 ? "one" : "them"} in the highlighted steps`);
  }
  return {
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim().slice(0, 200) : null,
    description: typeof doc.description === "string" ? doc.description.slice(0, 2000) : null,
    graph: { nodes, edges },
    newTemplates,
    reused: [...reused],
    warnings,
  };
}

/** After the new templates are created, swap the `pending:<i>` placeholders for their real ids. */
export function resolvePending(graph: Sequence["graph"], createdIds: string[]): Sequence["graph"] {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => n.type !== "send" ? n : {
      ...n,
      data: { ...n.data, template_ids: ((n.data.template_ids as string[]) ?? []).map((t) => (t.startsWith(PENDING) ? createdIds[+t.slice(PENDING.length)] : t)).filter(Boolean) },
    }),
  };
}

export const importProblems = (e: unknown): string[] => (e instanceof ImportError ? e.problems : [String((e as Error)?.message ?? e)]);

/** A complete, self-contained example: four templates and a branching sequence that uses them. */
export function sampleSequenceJson(): string {
  const sample = {
    version: SEQUENCE_JSON_VERSION,
    name: "Website redesign outreach",
    description: "Intro, a useful insight if they opened it, a case study if they didn't, then a meeting ask.",
    templates: [
      {
        name: "Sample 1 — Initial outreach",
        subject: "{Quick question|Idea} for {{Company|your team}}",
        body: "Hi {{FirstName|there}},\n\nI was looking at {{Company|your}} website and noticed a few quick wins that could lift enquiries — faster load times and a clearer call to action on mobile.\n\nWorth a short chat?\n\n{{sender_name}}",
      },
      {
        name: "Sample 2 — Insight",
        subject: "",
        body: "Hi {{FirstName|there}},\n\nOne thing that stood out: most visitors land on your home page from their phone, and the first button they see is below the fold. Moving it up is usually a one-day change.\n\nHappy to send a 2-minute video walkthrough if useful.",
      },
      {
        name: "Sample 3 — Case study",
        subject: "How a team like {{Company|yours}} doubled website leads",
        body: "<p>Hi {{FirstName|there}},</p><p>We recently rebuilt the site for a company in a similar space — enquiries went from 40 to 95 a month within a quarter.</p><p>I can share what we changed and what it cost. Interested?</p>",
      },
      {
        name: "Sample 4 — Meeting invitation",
        subject: "",
        body: "Hi {{FirstName|there}},\n\nWould a 15-minute call next week work? I'll bring three concrete ideas for {{Company|your site}}, no strings attached.\n\nIf now's not the right time, just let me know.\n\n{{sender_name}}",
        track_clicks: false,
      },
    ],
    steps: [
      { type: "email", label: "Initial outreach", templates: ["Sample 1 — Initial outreach"], same_thread: false },
      { type: "wait", days: 2, hours: 0, minutes: 0, working_days_only: true },
      {
        type: "condition", label: "Opened the intro?", check: "opened",
        yes: [
          { type: "email", label: "Insight", templates: ["Sample 2 — Insight"], same_thread: true },
          { type: "wait", days: 3, working_days_only: true },
          { type: "email", label: "Meeting invitation", templates: ["Sample 4 — Meeting invitation"], same_thread: true },
        ],
        no: [
          { type: "email", label: "Case study", templates: ["Sample 3 — Case study"], same_thread: false },
        ],
      },
    ],
    _help: {
      templates: "Created on import if your account doesn't already have a template with that name (existing ones are reused, never overwritten). name is required. subject: leave \"\" for a follow-up sent in the same thread. body: plain text (blank line = new paragraph) or HTML. Variables like {{FirstName|there}} (with a fallback) and spintax like {Hi|Hello} work. track_opens / track_clicks default to true.",
      steps: "Run top to bottom. A condition must be the last step of its list; what happens next goes inside its \"yes\" and \"no\" lists (which can nest).",
      email: "templates: one or more template names from the \"templates\" list or your account (or their IDs). With several, each lead gets one at random. same_thread: reply in the previous email's thread (default true).",
      wait: "days / hours / minutes (whole numbers, at least one above 0). working_days_only skips non-working days from the campaign schedule (default false).",
      condition: "check: \"opened\", \"clicked\" or \"replied\" — checked against every email sent to the lead in this campaign so far.",
    },
  };
  return JSON.stringify(sample, null, 2);
}
