import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

import type { RecordTone } from "./record-list";

export type Fact = {
  /** Stable key; defaults to `label`. A columnar `RecordList` places the fact by this id. */
  id?: string;
  label: string;
  value: ReactNode;
  tone?: RecordTone;
  /** Full text for a value a column may truncate. */
  title?: string;
  /** Extra classes on the value (`dd`), e.g. `font-mono tabular-nums`. */
  className?: string;
};

/** Places a fact (or its header label) in a columnar ledger's grid column. */
export function factColumnStyle(column: number | undefined) {
  if (column === undefined) return undefined;
  // SAFETY: React CSSProperties has no index signature for custom properties;
  // `--fact-column` is consumed only by ledger.css as a grid line number.
  return { "--fact-column": column } as CSSProperties;
}

const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const satisfies Record<RecordTone, string>;

/**
 * Inline labelled facts — `Label value · Label value` — as one `<dl>`.
 *
 * `emphasis="label"` (row facts) leads with a bold label and a muted value;
 * `emphasis="value"` (headline figures, totals) leads with the value. Stacked
 * label/value grids are `Ledger variant="facts"`, not this.
 *
 * Inside a columnar `RecordList` the same markup becomes the row's columns:
 * the `dl` dissolves (`display: contents`), each fact is placed by its column
 * id, and the `dt` stays readable to assistive tech while the header row shows
 * the label once (ledger.css).
 */
export function FactList({
  facts,
  emphasis = "label",
  columnOf,
  className,
}: {
  facts: readonly Fact[];
  emphasis?: "label" | "value";
  /** Grid column per fact id, set by a columnar `RecordRow`. */
  columnOf?: (id: string) => number | undefined;
  className?: string;
}) {
  if (facts.length === 0) return null;
  return (
    <dl
      data-fact-list={emphasis}
      className={cn(
        "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1",
        className,
      )}
    >
      {facts.map((fact) => {
        const id = fact.id ?? fact.label;
        const column = columnOf?.(id);
        return (
          <div
            key={id}
            data-fact={id}
            className="flex min-w-0 items-baseline gap-1.5"
            style={factColumnStyle(column)}
          >
            <dt
              className={
                emphasis === "label"
                  ? "font-medium whitespace-nowrap text-foreground"
                  : "whitespace-nowrap text-muted-foreground"
              }
            >
              {fact.label}
            </dt>
            <dd
              title={fact.title}
              className={cn(
                "min-w-0",
                emphasis === "label"
                  ? "text-muted-foreground"
                  : "text-foreground",
                fact.tone && TONE_TEXT[fact.tone],
                fact.className,
              )}
            >
              {fact.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
