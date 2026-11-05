import type { ReactNode } from "react";

import { useDenseCell } from "~/ui/common/stacked-value";

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
