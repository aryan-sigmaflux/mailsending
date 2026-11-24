/**
 * Sequence import format (version 1).
 *
 * A readable list of steps instead of the canvas's raw nodes/edges. Steps run top to bottom; a condition ends its
 * list and continues inside its "yes" / "no" branches (which are step lists themselves, nested as deep as needed).
 *
 * {
 *   "name": "Cold outreach",                      optional
 *   "description": "…",                           optional
 *   "steps": [
 *     { "type": "email", "label": "Intro", "templates": ["Intro email"], "same_thread": true },
 *     { "type": "wait", "days": 2, "hours": 0, "minutes": 0, "working_days_only": true },
 *     { "type": "condition", "label": "Opened?", "check": "opened" | "clicked" | "replied",
 *       "yes": [ …steps ], "no": [ …steps ] }
 *   ]
 * }
 *
 * Templates are matched by ID or by name (case-insensitive). Unknown ones don't block the import: the step is left
 * without that template and a warning says which names to fix.
 */
import type { GraphEdge, GraphNode, Sequence, Template } from "@/lib/types";

export const SEQUENCE_JSON_VERSION = 1;
const MAX_STEPS = 100;
const COL = 300; // canvas spacing between steps
const ROW = 170; // vertical spacing between branches

type Json = Record<string, unknown>;
export interface ImportResult {
  name: string | null;
  description: string | null;
  graph: Sequence["graph"];
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
const TYPE_ALIASES: Record<string, "send" | "wait" | "condition"> = {
  email: "send", send: "send", send_mail: "send", mail: "send", wait: "wait", delay: "wait", condition: "condition", if: "condition",
};

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
  const nodes: GraphNode[] = [{ id: "start", type: "start", position: { x: 80, y: 0 }, data: { label: "Start" } }];
  const edges: GraphEdge[] = [];
  const counters = { send: 0, wait: 0, condition: 0 };
  const byName = new Map<string, Template>();
  for (const t of templates) if (!byName.has(t.name.trim().toLowerCase())) byName.set(t.name.trim().toLowerCase(), t); // newest first
  let total = 0;

  const link = (source: string, target: string, handle?: "yes" | "no") =>
    edges.push({ id: `e${edges.length + 1}`, source, target, sourceHandle: handle ?? null });

  function num(step: Json, key: string, path: string): number {
    const v = step[key];
    if (v === undefined || v === null || v === "") return 0;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      problems.push(`${path}: "${key}" must be a whole number of 0 or more`);
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
        for (const ref of refs) {
          if (typeof ref !== "string" || !ref.trim()) { problems.push(`${p}: template names must be text`); continue; }
          const t = templates.find((x) => x.id === ref.trim()) ?? byName.get(ref.trim().toLowerCase());
          if (t) { if (!ids.includes(t.id)) ids.push(t.id); } else missing.add(ref.trim());
        }
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
    warnings.unshift(`No template named ${[...missing].map((m) => `“${m}”`).join(", ")} — pick ${missing.size === 1 ? "it" : "them"} in the highlighted steps, or create ${missing.size === 1 ? "it" : "them"} first and import again`);
  }
  return {
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim().slice(0, 200) : null,
    description: typeof doc.description === "string" ? doc.description.slice(0, 2000) : null,
    graph: { nodes, edges },
    warnings,
  };
}

export const importProblems = (e: unknown): string[] => (e instanceof ImportError ? e.problems : [String((e as Error)?.message ?? e)]);

/** A complete example covering every step type. Uses the account's own template names when it has some,
 *  so importing the sample works as-is. */
export function sampleSequenceJson(templates: Template[]): string {
  const pick = (i: number, fallback: string) => templates[i]?.name ?? templates[0]?.name ?? fallback;
  const sample = {
    version: SEQUENCE_JSON_VERSION,
    name: "Cold outreach — 4 touches",
    description: "Intro, bump if they opened it, a different angle if they didn't, then a final nudge.",
    steps: [
      { type: "email", label: "Intro", templates: [pick(0, "Intro email")], same_thread: false },
      { type: "wait", days: 2, hours: 0, minutes: 0, working_days_only: true },
      {
        type: "condition", label: "Opened the intro?", check: "opened",
        yes: [
          { type: "email", label: "Bump", templates: [pick(1, "Bump")], same_thread: true },
          { type: "wait", days: 3, working_days_only: true },
          { type: "email", label: "Final nudge", templates: [...new Set([pick(2, "Final nudge A"), pick(3, "Final nudge B")])], same_thread: true },
        ],
        no: [
          { type: "email", label: "New angle", templates: [pick(1, "New angle")], same_thread: false },
        ],
      },
    ],
    _help: {
      steps: "Run top to bottom. A condition must be the last step of its list; what happens next goes inside its \"yes\" and \"no\" lists (which can nest).",
      email: "templates: one or more template names or IDs — with several, each lead gets one at random. same_thread: reply in the previous email's thread (default true).",
      wait: "days / hours / minutes (whole numbers, at least one above 0). working_days_only skips non-working days from the campaign schedule (default false).",
      condition: "check: \"opened\", \"clicked\" or \"replied\" — checked against every email sent to the lead in this campaign so far.",
    },
  };
  return JSON.stringify(sample, null, 2);
}
