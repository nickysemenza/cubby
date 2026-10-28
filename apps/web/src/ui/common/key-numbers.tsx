import { Fragment, type ReactNode, useId } from "react";

import { cn } from "~/lib/utils";
import { ChangedValue, type ValueChange } from "~/ui/derived/value-change";
import { Skeleton } from "~/ui/primitives/skeleton";

import type { RecordTone } from "./record-list";

/** One key number: spend, on hand, a count. */
export interface KeyNumber {
  /** Stable key; defaults to `label`. */
  id?: string;
  label: string;
  value: ReactNode;
  /** Semantic value and scope for change feedback. */
  change?: ValueChange;
  /** Strip only: a quiet line under the number ("8 days ago"). */
  context?: ReactNode;
  /** Money reads in mono inline (CurrencyValue's `.money` does the same). */
  money?: boolean;
  /** A real condition on the number (a warning, a credit); never decoration. */
  tone?: RecordTone;
  /** Drill-through: the number becomes a button that filters its owner. */
  onSelect?: () => void;
  /** The drill-through this number currently applies. */
  active?: boolean;
  /** Tallies only: the count asks for a member (needs review), marked in signal. */
  attention?: boolean;
}

type KeyNumbersProps = {
  items: readonly KeyNumber[];
  /**
   * `strip`: joined cells between hairlines — detail headers, inspectors
   * (two-up when narrow) and dashboards. `inline`: one sentence of figures
   * ("$2,481.20 this year · 38 purchases") for list headers and dense places.
   * `tallies`: value-first running counts beneath a step or stage, between
   * soft hairlines.
   */
  layout: "strip" | "inline" | "tallies";
  /** Accessible name of the region ("Key numbers", "Spend summary"). */
  label: string;
  /** Strip only: a trailing chart cell (the detail monthly spend). */
  chart?: ReactNode;
  /** Strip only: placeholder cells while the figures load. */
  loadingCount?: number;
  className?: string;
  "data-testid"?: string;
};

/**
 * The one key-number component: a `section` named by `label` over a
 * `dl`, so each figure keeps its label for assistive tech in both layouts.
 */
export function KeyNumbers({
  items,
  layout,
  label,
  chart,
  loadingCount,
  className,
  "data-testid": testId,
}: KeyNumbersProps) {
  if (layout === "inline") {
    if (items.length === 0) return null;
    return (
      <section
        aria-label={label}
        className={cn("min-w-0", className)}
        data-testid={testId}
      >
        <dl className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-sm/4.5 text-muted-foreground">
          {items.map((item, index) => (
            <Fragment key={item.id ?? item.label}>
              {index > 0 && <span aria-hidden>·</span>}
              <InlineNumber item={item} />
            </Fragment>
          ))}
        </dl>
      </section>
    );
  }
  if (layout === "tallies") {
    if (items.length === 0) return null;
    return (
      <section
        aria-label={label}
        className={cn("min-w-0 border-y border-border/60", className)}
        data-testid={testId}
      >
        <dl className="flex min-w-0 flex-wrap">
          {items.map((item) => (
            <TallyNumber key={item.id ?? item.label} item={item} />
          ))}
        </dl>
      </section>
    );
  }
  const placeholders = items.length === 0 ? (loadingCount ?? 0) : 0;
  if (items.length === 0 && placeholders === 0 && chart == null) return null;
  return (
    <section
      aria-label={label}
      aria-busy={placeholders > 0 || undefined}
      className={cn(
        "min-w-0 overflow-hidden border-y border-border",
        className,
      )}
      data-testid={testId}
    >
      {/* Cells draw their start and top hairlines; the -1px offset hides the
          outer ones so wrapped rows stay ruled at any width. */}
      <dl className="-mt-px -ml-px grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]">
        {items.map((item) => (
          <StripNumber key={item.id ?? item.label} item={item} />
        ))}
        {Array.from({ length: placeholders }, (_, index) => (
          <div key={index} className={CELL_CLASS}>
            <Skeleton className="h-4.5 w-20" />
            <Skeleton className="mt-1 h-6 w-24" />
          </div>
        ))}
        {chart != null && (
          <div className={cn(CELL_CLASS, "col-span-2 min-w-0")}>{chart}</div>
        )}
      </dl>
    </section>
  );
}

const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const satisfies Record<RecordTone, string>;

const CELL_CLASS = "min-w-0 border-t border-l border-border px-3 py-2.5";

/** One-line labels keep values aligned across a row; values and context wrap
 * so no figure or qualifier is hidden. */
function StripNumber({ item }: { item: KeyNumber }) {
  const labelId = useId();
  return (
    <div className={cn(CELL_CLASS, item.onSelect && "relative hover:bg-muted")}>
      <dt id={labelId} className="truncate text-xs/4.5 text-muted-foreground">
        {item.label}
      </dt>
      <dd
        className={cn(
          "min-w-0 text-xl/7 font-semibold break-words text-foreground-strong tabular-nums [&_*]:text-inherit",
          item.tone && TONE_TEXT[item.tone],
          item.active && "text-link",
        )}
      >
        <Value item={item} labelId={labelId} />
      </dd>
      {item.context != null && (
        <dd className="min-w-0 text-xs/4.5 break-words text-muted-foreground">
          {item.context}
        </dd>
      )}
    </div>
  );
}

function TallyNumber({ item }: { item: KeyNumber }) {
  const labelId = useId();
  return (
    <div
      className={cn(
        "relative flex min-w-24 flex-col-reverse py-1.5 pr-4 not-first:border-l not-first:border-border/60 not-first:pl-4 max-md:min-w-20",
        item.onSelect && "hover:[&_dt]:text-foreground hover:[&_dt]:underline",
      )}
    >
      <dt id={labelId} className="text-xs/4 text-muted-foreground">
        {item.label}
      </dt>
      <dd
        className={cn(
          "flex items-center gap-1.5 font-mono text-sm/5.5 font-semibold text-foreground-strong tabular-nums",
          item.tone && TONE_TEXT[item.tone],
          item.active && "text-link",
        )}
      >
        {item.attention ? (
          <span aria-hidden className="h-3.5 w-0.75 rounded-xs bg-signal" />
        ) : null}
        <Value item={item} labelId={labelId} />
      </dd>
    </div>
  );
}

function InlineNumber({ item }: { item: KeyNumber }) {
  const labelId = useId();
  return (
    <div
      className={cn(
        "inline-flex items-baseline gap-1",
        item.onSelect && "relative hover:text-foreground",
      )}
    >
      <dt id={labelId} className="order-last">
        {item.label}
      </dt>
      <dd
        className={cn(
          "font-semibold text-foreground tabular-nums [&_.money]:font-mono",
          item.money && "font-mono",
          item.tone && TONE_TEXT[item.tone],
          item.active && "text-link",
        )}
      >
        <Value item={item} labelId={labelId} />
      </dd>
    </div>
  );
}

/**
 * A drill-through value stays inside its `dd` (a button may not wrap the
 * description terms); its hit area stretches over the whole figure and it is
 * named by both the label and the value.
 */
function Value({ item, labelId }: { item: KeyNumber; labelId: string }) {
  const valueId = useId();
  const value = <ChangedValue change={item.change}>{item.value}</ChangedValue>;
  if (!item.onSelect) return value;
  return (
    <button
      type="button"
      id={valueId}
      onClick={item.onSelect}
      aria-pressed={item.active}
      aria-labelledby={`${labelId} ${valueId}`}
      className="rounded-sm text-inherit outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
    >
      {value}
    </button>
  );
}
