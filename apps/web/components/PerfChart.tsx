"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { longDate, monthShort, num } from "@/lib/format";

export interface Point { t: string; sent: number; opened: number; replied: number; clicked?: number }
export type Metric = "sent" | "opened" | "clicked" | "replied";

/** Monotone cubic interpolation (no overshoot) — same curve as the design mockup. */
function monotone(p: [number, number][]) {
  const n = p.length;
  if (n < 2) return n ? `M${p[0][0]},${p[0][1]}` : "";
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i++) { const h = dx[i] / 3; d += ` C${p[i][0] + h},${p[i][1] + t[i] * h} ${p[i + 1][0] - h},${p[i + 1][1] - t[i + 1] * h} ${p[i + 1][0]},${p[i + 1][1]}`; }
  return d;
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p / 0.5) * 0.5 * p;
}

const short = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)));

export function PerfChart({ points, range, metric = "sent", height = 250 }: { points: Point[]; range: string; metric?: Metric; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  const vals = points.map((p) => p[metric] ?? 0);
  const max = niceMax(Math.max(0, ...vals));
  const L = 46, R = 8, T = 14, B = 34, H = height;
  const n = Math.max(points.length, 2);
  const px = (i: number) => L + (i * (w - L - R)) / (n - 1);
  const py = (v: number) => T + (H - T - B) * (1 - v / max);
  const pts = vals.map((v, i) => [px(i), py(v)] as [number, number]);
  const drawKey = `${metric}-${range}-${vals.join(",")}`;
  const line = monotone(pts);
  const area = pts.length ? `${line} L${px(pts.length - 1)},${H - B} L${px(0)},${H - B} Z` : "";

  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => max * f);
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const fmtX = (iso: string) => {
    const d = new Date(iso);
    if (range === "1D") return `${String(d.getHours()).padStart(2, "0")}:00`;
    if (range === "1W") return d.toLocaleDateString("en-US", { weekday: "short" });
    if (range === "1M") return String(d.getDate());
    return monthShort(d) + (range === "6M" ? ` ${d.getDate()}` : "");
  };

  const idx = hover ?? (points.length ? vals.lastIndexOf(Math.max(...vals)) : null);
  const cur = idx != null && points[idx] ? idx : null;
  const change = cur != null && cur > 0 && vals[cur - 1] ? ((vals[cur] - vals[cur - 1]) / vals[cur - 1]) * 100 : null;
  const tipW = 176;

  return (
    <div
      ref={ref}
      className="plot"
      style={{ height: H }}
      onMouseMove={(e) => {
        if (!points.length) return;
        const r = ref.current!.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - L) / (w - L - R)) * (n - 1));
        setHover(Math.max(0, Math.min(points.length - 1, i)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      {w > 0 && (
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={`Emails ${metric} over time`}>
          <defs>
            <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#c79bb8" stopOpacity=".45" />
              <stop offset=".6" stopColor="#8a6079" stopOpacity=".16" />
              <stop offset="1" stopColor="#4a3341" stopOpacity="0" />
            </linearGradient>
            <filter id="lg" x="-5%" y="-30%" width="110%" height="160%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {ticks.map((tk, i) => (
            <g key={i}>
              <line x1={L} x2={w - R} y1={py(tk)} y2={py(tk)} stroke="rgba(255,255,255,.06)" />
              <text className="yl" x={L - 12} y={py(tk) + 4} textAnchor="end">{tk === 0 ? 0 : short(tk)}</text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 ? <text key={i} className="xl" x={px(i)} y={H - 8} textAnchor="middle">{fmtX(p.t)}</text> : null,
          )}
          <path key={`a-${drawKey}`} className="chart-area" d={area} fill="url(#ag)" />
          <path key={`l-${drawKey}`} className="chart-line" d={line} fill="none" stroke="#dcb6cf" strokeWidth={2} filter="url(#lg)" strokeLinecap="round" pathLength={1} strokeDasharray={1} />
        </svg>
      )}
      {w > 0 && cur != null && (
        <>
          <div className="guide" style={{ left: px(cur), top: py(vals[cur]), height: H - B - py(vals[cur]) }} />
          <div className="pdot" style={{ left: px(cur), top: py(vals[cur]) }} />
          <div
            className="ptip"
            style={{
              left: Math.max(0, Math.min(w - tipW, px(cur) - tipW / 2)),
              top: py(vals[cur]) - 100 < -20 ? py(vals[cur]) + 18 : py(vals[cur]) - 96,
            }}
          >
            <div className="flex justify-between text-[11.5px] text-txt-2">
              <span>{range === "1D" ? `${fmtX(points[cur].t)} · ${longDate(new Date(points[cur].t))}` : longDate(new Date(points[cur].t))}</span>
            </div>
            <div className="flex justify-between items-center mt-3">
              <b className="font-medium text-[16px]">{num(vals[cur])} <small className="text-[11px] text-muted font-light">{metric}</small></b>
              {change != null && (
                <span className={`badge ${change < 0 ? "b-red" : "b-green"}`}>
                  {change < 0 ? <TrendingDown /> : <TrendingUp />}
                  {change > 0 ? "+" : ""}{change.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
