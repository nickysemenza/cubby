import type { ReactNode } from "react";

import { useDenseCell } from "~/ui/values/stacked-value";

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
      {/* A thin bar along the cell's foot; a full-cell block read as a selection. */}
      {fraction !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[calc((var(--table-cell-leading)_-_var(--table-row-height))/2_+_1px)] left-0 h-[3px] bg-foreground/15"
          style={{ width: `${fraction * 100}%` }}
        />
      )}
      <span className="relative block">{children}</span>
      <span className="sr-only">. {label}</span>
    </span>
  );
}
