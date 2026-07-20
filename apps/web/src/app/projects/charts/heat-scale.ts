// Shared cell styling + heat scale for the trade cross-tabs (Trade × Cost Type,
// Trade × Project). One scale so the two matrices read as the same instrument.

export const cellMono = "px-2 py-2 text-right font-mono text-xs tabular-nums";

export type HeatBucket = 0 | 1 | 2 | 3 | 4 | 5;

// Dollar sums are heavy-tailed, so bucket on a sqrt-scaled ratio against the
// grid-wide max (one shared scale, like Sheets' color-scale).
export function heatBucket(value: number, max: number): HeatBucket {
  if (value <= 0 || max <= 0) return 0;
  const t = Math.sqrt(value / max);
  if (t >= 0.85) return 5;
  if (t >= 0.6) return 4;
  if (t >= 0.35) return 3;
  if (t >= 0.15) return 2;
  return 1;
}

export const HEAT_CLASSES: Record<HeatBucket, string> = {
  0: "",
  1: "bg-chart-seq-1",
  2: "bg-chart-seq-2",
  3: "bg-chart-seq-3",
  4: "bg-chart-seq-4 text-background", // deep fills flip to paper ink
  5: "bg-chart-seq-5 text-background",
};
