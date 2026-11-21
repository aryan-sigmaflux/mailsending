"use client";

import { useEffect, useRef, useState } from "react";

/** Animated count-up (eases out); respects reduced motion. */
export function useCountUp(target: number, duration = 1400) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduced = typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = reduced ? 0 : duration;
    const start = performance.now();
    const base = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = dur ? Math.min(1, Math.max(0, (now - start) / dur)) : 1;
      const val = Math.round(base + (target - base) * (1 - Math.pow(1 - p, 4)));
      setV(val);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

/** Cycles through strings every `ms`, for rotating placeholders. */
export function useRotating(items: string[], ms = 3200) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % items.length), ms);
    return () => clearInterval(id);
  }, [items.length, ms]);
  return items[i];
}
