export type Features = Record<"warmup" | "sequences" | "apollo" | "ai" | "tracking_domain", boolean>;

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: "super_admin" | "user";
  status: "active" | "suspended";
  timezone: string;
  expires_at: string | null;
  last_login_at: string | null;
  created_at: string;
  max_daily_emails: number;
  max_monthly_emails: number;
  max_domains: number;
  max_mailboxes: number;
  max_campaigns: number;
  max_contacts: number;
  verify_credits_monthly: number;
  features: Features;
  tracking_domain: string | null;
}

export interface Usage {
  emails_today: number;
  emails_month: number;
  verifications_month: number;
  domains: number;
  mailboxes: number;
  active_campaigns: number;
  contacts: number;
}

export interface Me {
  user: User;
  usage: Usage;
}

export interface CheckItem {
  status: "pass" | "warn" | "fail";
  message: string;
  record?: string | string[] | null;
  policy?: string | null;
  records?: { priority: number; host: string }[];
  selectors?: { selector: string; record: string }[];
  listed?: { list: string; target: string }[];
  checked?: number;
  expected?: string;
}

export interface DomainCheck {
  domain: string;
  score: number;
  mx: CheckItem;
  spf: CheckItem;
  dkim: CheckItem;
  dmarc: CheckItem;
  blacklists: CheckItem;
  ownership: CheckItem | null;
  checked_at: string;
}

export interface Domain {
  id: string;
  name: string;
  verified: boolean;
  verify_token: string;
  health_score: number | null;
  last_check: DomainCheck | null;
  checked_at: string | null;
  created_at: string;
  mailbox_count: number;
}

export interface Mailbox {
  id: string;
  provider: "smtp" | "google" | "microsoft";
  email: string;
  from_name: string;
  signature_html: string;
  domain_id: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string;
  smtp_username: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string;
  imap_username: string | null;
  daily_limit: number;
  min_delay_seconds: number;
  max_delay_seconds: number;
  warmup_enabled: boolean;
  warmup: { start_per_day: number; ramp_per_day: number; max_per_day: number; reply_rate: number };
  status: "active" | "error" | "paused";
  last_error: string | null;
  health_score: number;
  last_sent_at: string | null;
  created_at: string;
  sent_today: number;
}

export interface ContactList {
  id: string;
  name: string;
  description: string;
  source: string;
  columns: string[];
  created_at: string;
  contact_count: number;
}

export interface Contact {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
  phone: string;
  website: string;
  linkedin_url: string;
  city: string;
  country: string;
  fields: Record<string, string>;
  source: string;
  verify_status: VerifyStatus;
  verify_reason: string;
  unsubscribed: boolean;
  created_at: string;
}

export type VerifyStatus = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

export interface Template {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  track_opens: boolean;
  track_clicks: boolean;
  variables: string[];
  created_at: string;
  updated_at: string;
}

export type NodeKind = "start" | "send" | "wait" | "condition";

export interface GraphNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface Sequence {
  id: string;
  name: string;
  description: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  created_at: string;
  updated_at: string;
}

export interface CampaignStats {
  contacts: number;
  live: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

export interface Campaign {
  id: string;
  name: string;
  kind: "single" | "sequence";
  status: "draft" | "running" | "paused" | "completed";
  sequence_id: string | null;
  template_ids: string[];
  list_ids: string[];
  mailbox_ids: string[];
  /** mode "instant" sends any day/time until done; "window" (also when missing, for older campaigns) uses days + start–end. */
  schedule: { mode?: "instant" | "window"; timezone: string; days: number[]; start: string; end: string; start_at: string | null };
  settings: { daily_cap: number; stop_on_reply: boolean };
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  stats: CampaignStats;
}

export interface Integration {
  id: string;
  kind: "ai" | "apollo";
  provider: string;
  mode: "api" | "mcp";
  label: string;
  key_hint: string;
  config: Record<string, string>;
  is_default: boolean;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  created_at: string;
}

export interface Paged<T> {
  total: number;
  items: T[];
}
