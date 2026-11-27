"use client";

import {
  Bell, Contact, FileText, Flame, Globe, Inbox, LayoutDashboard, LifeBuoy, LogOut, Mail, MailCheck, ScanSearch, Send, Settings,
  ShieldCheck, Sparkles, Users, Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { initials } from "@/lib/format";
import { Spinner } from "./ui";

type Item = { href: string; label: string; icon: ReactNode; feature?: string; admin?: boolean };

const NAV: { label?: string; items: Item[] }[] = [
  { items: [{ href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard /> }] },
  {
    label: "Outreach",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: <Send /> },
      { href: "/sequences", label: "Sequences", icon: <Workflow />, feature: "sequences" },
      { href: "/templates", label: "Templates", icon: <FileText /> },
      { href: "/inbox", label: "Unibox", icon: <Inbox /> },
    ],
  },
  {
    label: "Leads",
    items: [
      { href: "/contacts", label: "Contacts", icon: <Contact /> },
      { href: "/leads", label: "Lead lists", icon: <Users /> },
      { href: "/leads/research", label: "Research leads", icon: <ScanSearch /> },
      { href: "/lead-finder", label: "Lead Finder", icon: <Sparkles />, feature: "apollo" },
      { href: "/verifier", label: "Email verifier", icon: <MailCheck /> },
    ],
  },
  {
    label: "Deliverability",
    items: [
      { href: "/mailboxes", label: "Mailboxes", icon: <Mail /> },
      { href: "/domains", label: "Domains", icon: <Globe /> },
      { href: "/warmup", label: "Warmup", icon: <Flame />, feature: "warmup" },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { me, ready, load, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) load().then((m) => !m && router.replace("/login"));
  }, [ready, load, router]);

  useEffect(() => {
    const close = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, []);

  if (!ready || !me) {
    return (
      <div className="shell" style={{ gridTemplateColumns: "1fr", placeItems: "center" }}>
        <Spinner size={28} />
      </div>
    );
  }

  const { user } = me;
  const matches = (href: string) => path === href || path.startsWith(href + "/");
  // The most specific item wins, so /leads/research highlights "Research leads", not "Lead lists" too.
  const isOn = (href: string) => matches(href) && !NAV.some((g) => g.items.some((i) => i.href.length > href.length && i.href.startsWith(href) && matches(i.href)));
  const enabled = (i: Item) => !i.feature || user.role === "super_admin" || user.features?.[i.feature as keyof typeof user.features];

  return (
    <div className="shell">
      <aside className="side" aria-label="Main navigation">
        <Link href="/dashboard" className="brand">
          <Mail width={23} height={23} strokeWidth={2.4} />
          <b>Sigmaflux Mail</b>
        </Link>
        <nav className="nav">
          {NAV.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-0.5">
              {group.label && <div className="nav-label">{group.label}</div>}
              {group.items.filter(enabled).map((i) => (
                <Link key={i.href} href={i.href} className={isOn(i.href) ? "on" : ""} title={i.label}>
                  {i.icon}
                  <span>{i.label}</span>
                </Link>
              ))}
            </div>
          ))}
          {user.role === "super_admin" && (
            <div className="flex flex-col gap-0.5">
              <div className="nav-label">Admin</div>
              <Link href="/admin" className={isOn("/admin") ? "on" : ""} title="Admin panel">
                <ShieldCheck />
                <span>Admin panel</span>
              </Link>
            </div>
          )}
        </nav>
        <nav className="nav side-foot">
          <Link href="/settings" className={isOn("/settings") ? "on" : ""} title="Settings"><Settings /><span>Settings</span></Link>
          <a href="mailto:support@sigmaflux.io" title="Support"><LifeBuoy /><span>Support</span></a>
        </nav>
      </aside>

      <div className="main">
        <div className="flex items-center justify-end gap-2" style={{ marginBottom: -6 }}>
          <Link href="/inbox" className="ibtn" aria-label="Replies"><Bell /></Link>
          <div className="relative" ref={menuRef}>
            <button className="flex items-center gap-3 ml-2 text-left" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
              <span className="avatar">{initials(user.full_name, user.email)}</span>
              <span className="hidden sm:block">
                <b className="block font-normal text-[14px] leading-tight">{user.full_name || user.email.split("@")[0]}</b>
                <small className="text-[11.5px] text-txt-2 font-light">{user.email}</small>
              </span>
            </button>
            {menu && (
              <div className="modal" style={{ position: "absolute", right: 0, top: 52, width: 220, padding: 8, zIndex: 40 }} role="menu">
                <Link href="/settings" className="btn btn-sm w-full justify-start" onClick={() => setMenu(false)}><Settings /> Settings</Link>
                <button className="btn btn-sm w-full justify-start" onClick={logout}><LogOut /> Log out</button>
              </div>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
