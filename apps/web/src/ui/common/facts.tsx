import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";
import type { RecordTone } from "./record-list";

/** One labelled value. List-only parts are ignored by the inline layout. */
export interface Fact {
  /** Stable key; defaults to `label`. A columnar `RecordList` places the fact by this id. */
  id?: string;
  label: string;
  value: ReactNode;
  tone?: RecordTone;
  /** Full text for a value a column may truncate. */
  title?: string;
  /** Extra classes on the value (`dd`), e.g. `font-mono tabular-nums`. */
  className?: string;
  /** List: quiet provenance beside the value; wraps within the value slot. */
  caption?: ReactNode;
  /** List: a browse/filter action kept outside editable values and links. */
  filterAction?: ReactNode;
  /** List: how the value is determined, behind a hover info control. */
  explanation?: ReactNode;
  /** List: the field's quality result beneath its value. */
  quality?: ReactNode;
  /** List: a stable row anchor for quality summary links. */
  anchor?: string;
  /** List: prose takes the full width instead of the value column. */
  fullWidth?: boolean;
  hide?: boolean;
}

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
 * List facts lay out as `grid` (a label column, reflowing to two columns on a
 * container at least 40rem wide) or `compact` (a fixed label share with every
 * value on one left edge) on narrow surfaces such as the inspector.
 */
type FactsDensity = "grid" | "compact";
const FactsDensityContext = createContext<FactsDensity>("grid");

export function FactsDensityProvider({
  density,
  children,
}: {
  density: FactsDensity;
  children: ReactNode;
}) {
  return <FactsDensityContext value={density}>{children}</FactsDensityContext>;
}

const FactsAddContext = createContext<(() => void) | null>(null);

/**
 * Where an empty editable fact goes to be filled in (the record's edit
 * dialog). Without one, empty facts read as a quiet dash.
 */
export function FactsAddProvider({
  onAdd,
  children,
}: {
  onAdd: (() => void) | null;
  children: ReactNode;
}) {
  return <FactsAddContext value={onAdd}>{children}</FactsAddContext>;
}

export function useFactsAdd() {
  return useContext(FactsAddContext);
}

/** The quiet value an empty editable fact shows. */
export function AddFactValue({
  label,
  onAdd,
}: {
  label: string;
  onAdd: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Add ${label}`}
      onClick={onAdd}
      className="rounded-sm text-muted-foreground outline-none hover:text-foreground-strong hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      Add…
    </button>
  );
}

type FactsProps = {
  facts: readonly Fact[];
  /**
   * `inline`: `Label value · Label value` in one wrapping line (record rows,
   * evidence). `list`: the detail and inspector property list, one row per
   * fact with captions, info controls and quality results.
   */
  layout: "inline" | "list";
  /** Inline: grid column per fact id, set by a columnar `RecordRow`. */
  columnOf?: (id: string) => number | undefined;
  className?: string;
};

/**
 * Labelled values as one `dl`: a muted label and a foreground value. Inside a
 * columnar `RecordList` the inline `dl` dissolves (`display: contents`), each
 * fact is placed by its column id, and the `dt` stays readable to assistive
 * tech while the header row shows the label once (ledger.css).
 */
export function Facts({ facts, layout, columnOf, className }: FactsProps) {
  const visible = facts.filter(
    (fact) => !fact.hide && fact.value !== undefined,
  );
  const density = useContext(FactsDensityContext);
  if (visible.length === 0) return null;
  if (layout === "list") {
    return (
      <Ledger
        as="dl"
        variant="facts"
        data-facts-layout={density}
        className={className}
      >
        {visible.map((fact) => (
          <FactRow key={fact.id ?? fact.label} fact={fact} />
        ))}
      </Ledger>
    );
  }
  return (
    <dl
      data-fact-list="inline"
      className={cn(
        "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1",
        className,
      )}
    >
      {visible.map((fact) => {
        const id = fact.id ?? fact.label;
        return (
          <div
            key={id}
            data-fact={id}
            className="flex min-w-0 items-baseline gap-1.5"
            style={factColumnStyle(columnOf?.(id))}
          >
            <dt className="whitespace-nowrap text-muted-foreground">
              {fact.label}
            </dt>
            <dd
              title={fact.title}
              className={cn(
                "min-w-0 text-foreground",
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

function FactRow({ fact }: { fact: Fact }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <LedgerRow as="div" id={fact.anchor} data-full-width={fact.fullWidth}>
      <LedgerCell
        as="dt"
        slot="primary"
        data-slot="fact-label"
        className="text-muted-foreground"
      >
        {fact.label}
      </LedgerCell>
      <LedgerCell as="dd" slot="secondary" data-slot="fact-value">
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 break-words [&>*]:max-w-full [&>*]:min-w-0",
            fact.tone && TONE_TEXT[fact.tone],
            fact.className,
          )}
        >
          {fact.value}
          {fact.caption && (
            <span className="min-w-0 text-xs text-muted-foreground">
              {fact.caption}
            </span>
          )}
        </div>
        {fact.quality ? <div className="mt-0.5">{fact.quality}</div> : null}
      </LedgerCell>
      {(fact.filterAction || fact.explanation) && (
        <LedgerCell as="dd" slot="actions">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {fact.filterAction}
            {fact.explanation ? (
              <Button
                variant="ghost"
                size="icon-xs"
                data-slot="fact-explain"
                aria-label={`How ${fact.label.toLowerCase()} is determined`}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen(!open)}
              >
                <InfoIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </LedgerCell>
      )}
      {fact.explanation && open ? (
        <LedgerCell
          as="dd"
          slot="detail"
          id={panelId}
          className="border-t border-border py-2"
        >
          {fact.explanation}
        </LedgerCell>
      ) : null}
    </LedgerRow>
  );
}
