/**
 * Which {{variables}} a set of templates uses, and the lead-CSV column each one needs.
 * Mirrors the API's matching (services/renderer.py + routers/contacts.py): keys are compared lower-cased with
 * punctuation removed, a few friendly aliases map to standard fields, and anything else is a custom CSV column.
 */
const VAR_RE = /\{\{\s*([A-Za-z0-9_ .-]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;
export const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const SYSTEM = new Set(["unsubscribeurl", "sendername", "senderemail"]);
/** Filled by Research leads (API: services/research.py ENRICH_FIELDS) — not a CSV column. */
export const RESEARCH_VARS = new Set([
  "sitescore", "siteissuecount", "topissue", "siteissues", "sitesummary", "topkeyword", "topkeywordvolume", "topkeywordcpc",
  "keywordstotalvolume", "keyword1", "keyword2", "keyword3", "keyword4", "keyword5", "pagespeedscore",
  "smartkeyword1", "smartkeyword2", "smartkeyword3", "smartkeyword4", "smartkeyword5",
]);
const STANDARD = ["email", "first_name", "last_name", "company", "title", "phone", "website", "linkedin_url", "city", "country"];
const ALIASES: Record<string, string> = {
  name: "first_name", firstname: "first_name", first: "first_name", lastname: "last_name", last: "last_name", surname: "last_name",
  fullname: "full_name", companyname: "company", organization: "company", organisation: "company",
  jobtitle: "title", position: "title", designation: "title", linkedin: "linkedin_url", site: "website", url: "website", location: "city",
};

export type VarKind = "standard" | "custom" | "system" | "research";
export interface VarUse { template: string; step: string }
export interface SequenceVar {
  key: string;            // normalized
  name: string;           // as first written, e.g. "FirstName"
  kind: VarKind;
  columns: string[];      // CSV column(s) that fill it; [] for system variables
  fallbacks: string[];    // distinct fallbacks written for it
  alwaysFallback: boolean; // every use has a fallback → leads without the value still read fine
  uses: VarUse[];
}

/** The CSV column(s) a variable reads from. */
export function columnsFor(name: string): { kind: VarKind; columns: string[] } {
  const k = normKey(name);
  if (SYSTEM.has(k)) return { kind: "system", columns: [] };
  if (RESEARCH_VARS.has(k)) return { kind: "research", columns: [] };
  const std = STANDARD.find((f) => normKey(f) === k) ?? ALIASES[k];
  if (std === "full_name") return { kind: "standard", columns: ["first_name", "last_name"] };
  if (std) return { kind: "standard", columns: [std] };
  return { kind: "custom", columns: [name.trim()] };
}

/** Every variable used by the given templates (subject + body), in first-seen order. */
export function sequenceVariables(items: { template: { name: string; subject: string; body_html: string }; step: string }[]): SequenceVar[] {
  const out = new Map<string, SequenceVar>();
  for (const { template, step } of items) {
    for (const text of [template.subject, template.body_html]) {
      for (const m of (text ?? "").matchAll(VAR_RE)) {
        const name = m[1].trim(), fallback = m[2];
        const key = normKey(name);
        let v = out.get(key);
        if (!v) {
          v = { key, name, ...columnsFor(name), fallbacks: [], alwaysFallback: true, uses: [] };
          out.set(key, v);
        }
        if (fallback) { if (!v.fallbacks.includes(fallback)) v.fallbacks.push(fallback); } else v.alwaysFallback = false;
        if (!v.uses.some((u) => u.template === template.name && u.step === step)) v.uses.push({ template: template.name, step });
      }
    }
  }
  return [...out.values()];
}

/** Header row for a lead CSV that fills every variable: email first, then standard fields, then custom ones. */
export function csvColumns(vars: SequenceVar[]): string[] {
  const cols = ["email"];
  for (const v of [...vars.filter((x) => x.kind === "standard"), ...vars.filter((x) => x.kind === "custom")]) {
    for (const c of v.columns) if (!cols.some((x) => normKey(x) === normKey(c))) cols.push(c);
  }
  return cols;
}
