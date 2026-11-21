export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");

export const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return "in " + until(iso);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function until(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const ordinal = (d: number) => d + (["th", "st", "nd", "rd"][((d % 100) - 20) % 10] || ["th", "st", "nd", "rd"][d % 100] || "th");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const longDate = (d: Date) => `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const monthShort = (d: Date) => MONTHS[d.getMonth()];

export const initials = (name: string, email: string) =>
  (name || email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

export const firstName = (name: string, email: string) => (name || email.split("@")[0]).split(" ")[0];

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const TIMEZONES = [
  "UTC", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "Europe/Paris",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Australia/Sydney",
];
