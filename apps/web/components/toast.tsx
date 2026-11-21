"use client";

import { CircleCheck, CircleExclamationPoint, Info, X } from "lucide-react";
import { create } from "zustand";

type Kind = "ok" | "err" | "info";
interface Toast { id: number; kind: Kind; text: string }

const useToasts = create<{ items: Toast[]; push: (k: Kind, t: string) => void; drop: (id: number) => void }>((set) => ({
  items: [],
  push: (kind, text) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { id, kind, text }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), kind === "err" ? 7000 : 4000);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = {
  ok: (t: string) => useToasts.getState().push("ok", t),
  err: (t: unknown) => useToasts.getState().push("err", t instanceof Error ? t.message : String(t)),
  info: (t: string) => useToasts.getState().push("info", t),
};

export function Toaster() {
  const { items, drop } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.kind === "ok" ? <CircleCheck color="var(--green)" /> : t.kind === "err" ? <CircleExclamationPoint color="var(--red)" /> : <Info color="var(--blue)" />}
          <span style={{ flex: 1 }}>{t.text}</span>
          <button onClick={() => drop(t.id)} aria-label="Dismiss" style={{ opacity: 0.6 }}><X width={15} /></button>
        </div>
      ))}
    </div>
  );
}
