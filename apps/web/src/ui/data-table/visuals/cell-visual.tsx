import type { ReactNode } from "react";

import { useDenseCell } from "~/ui/common/stacked-value";

import { CellFrame } from "../cell-frame";

/** Signed values retain their text; the bar compares magnitude on one shared scale. */
export function CellMagnitudeBar({
  value,
  maximum,
  children,
}: {
  value: unknown;
  maximum: number;
  children: ReactNode;
}) {
  const dense = useDenseCell();
  if (!dense || typeof value !== "number" || !Number.isFinite(value))
    return children;
  return (
    <CellBar
      value={Math.abs(value)}
      maximum={maximum}
      label={`Bar compares absolute magnitude across loaded rows; maximum ${maximum}. Signed value shown in text.`}
    >
      {children}
    </CellBar>
  );
}

/** Visuals are supplementary: the caller retains editing and clipboard ownership. */
export function CellBar({
  value,
  maximum,
  label,
  children,
}: {
  value: number | null;
  maximum: number;
  label: string;
  children: ReactNode;
}) {
  const fraction =
    value === null || maximum <= 0
      ? null
      : Math.max(0, Math.min(1, value / maximum));
  return (
    <span className="relative block w-full" title={label}>
      {fraction !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 bg-foreground/10"
          style={{ width: `${fraction * 100}%` }}
        />
      )}
      <span className="relative block">{children}</span>
      <span className="sr-only">. {label}</span>
    </span>
  );
}

/** A shared domain keeps row-to-row comparisons honest; null samples break the line. */
export function CellSparkline({
  samples,
  minimum,
  maximum,
  label,
  children,
}: {
  samples: readonly (number | null)[];
  minimum: number;
  maximum: number;
  label: string;
  children: ReactNode;
}) {
  const span = maximum - minimum;
  const path = samples.reduce(
    (result, sample, index) => {
      if (sample === null) return { path: result.path, connected: false };
      const x = samples.length <= 1 ? 40 : (index / (samples.length - 1)) * 80;
      const y =
        span <= 0
          ? 10
          : 18 - Math.max(0, Math.min(1, (sample - minimum) / span)) * 16;
      return {
        path: `${result.path} ${result.connected ? "L" : "M"}${x},${y}`,
        connected: true,
      };
    },
    { path: "", connected: false },
  ).path;
  return (
    <CellFrame
      trailing={
        <svg
          aria-hidden="true"
          viewBox="0 0 80 20"
          className="h-5 w-20 text-muted-foreground"
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      }
    >
      <span title={label}>
        {children}
        <span className="sr-only">. {label}</span>
      </span>
    </CellFrame>
  );
}
