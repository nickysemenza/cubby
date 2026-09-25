import type * as React from "react";
import { Eyebrow } from "~/components/ui/eyebrow";
import { Grid } from "~/components/layout";

export interface SummaryItem {
  label: string;
  value: string | number;
  formatter?: (value: string | number) => string;
  /** Optional small muted caption rendered beneath the value. */
  caption?: string;
  /** Optional hover tooltip for the caption. */
  captionTitle?: string;
  /** Optional secondary line rendered beneath the value. */
  subValue?: string;
}

/**
 * One ledger metric: a mono eyebrow label over a big tabular number, with an
 * optional secondary line (e.g. "$0.42 / serving") and a muted caption (e.g.
 * coverage). This markup was duplicated across the summary card, the recipe
 * detail, and the nutrition charts — it lives here once now.
 *
 * Pass either a `SummaryItem` (label/value/formatter/subValue/caption) for the
 * data-driven case, or `label` + `children` for ad-hoc values (custom units,
 * JSX values).
 */
export function StatTile({
  item,
  label,
  children,
  className,
}: {
  item?: SummaryItem;
  label?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const resolvedLabel = item?.label ?? label;
  const value = item
    ? item.formatter
      ? item.formatter(item.value)
      : item.value
    : children;

  return (
    <div className={className}>
      {resolvedLabel && <Eyebrow as="div">{resolvedLabel}</Eyebrow>}
      <div className="font-mono font-semibold text-foreground text-lg tabular-nums">
        {value}
      </div>
      {item?.subValue && (
        <div className="font-mono text-2xs text-muted-foreground tabular-nums">
          {item.subValue}
        </div>
      )}
      {item?.caption && (
        <div
          className={
            item.captionTitle
              ? "cursor-help font-mono text-2xs text-warning-ink decoration-dotted underline underline-offset-2"
              : "font-mono text-2xs text-muted-foreground"
          }
          title={item.captionTitle}
        >
          {item.caption}
        </div>
      )}
    </div>
  );
}

/**
 * The standard row of stat tiles: an auto-fit grid that stretches the present
 * metrics to fill the row (4 for recipe/inventory, up to 6 for nutrition) and
 * wraps to 2–3 across on mobile. Wrapper over the shared `summary` grid.
 */
export function StatGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Grid cols="summary" className={className}>
      {children}
    </Grid>
  );
}
