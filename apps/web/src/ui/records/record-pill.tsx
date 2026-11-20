import { cn } from "cn";
import { createContext, type ReactNode, useContext } from "react";

import { useDenseCell } from "../values/stacked-value";

/**
 * Which optional slots the surrounding surface has room for. A pill never
 * decides this itself: the same record reads differently in prose, in a list
 * of mixed records and under a header that already names its type.
 */
type RecordPillSlots = {
  /** The shortcode prefix, for lists that mix record types. */
  type: boolean;
  /** The muted text after the title. */
  qualifier: boolean;
  /** The record's one declared fact. */
  fact: boolean;
};

const HOSTS = {
  /** Detail values and anything undeclared: what the reference already carries. */
  default: { type: false, qualifier: true, fact: true },
  /** A sentence or note: the pill must not outweigh the words around it. */
  prose: { type: false, qualifier: false, fact: false },
  /** Activity and lists that mix record types. */
  mixed: { type: true, qualifier: true, fact: true },
  /** Rows whose columns or header already state the type and the facts. */
  columns: { type: false, qualifier: false, fact: false },
} as const satisfies Record<string, RecordPillSlots>;

type RecordPillHostKind = keyof typeof HOSTS;

const RecordPillHostContext = createContext<RecordPillHostKind>("default");

/** Declares what the pills inside this surface draw. */
export function RecordPillHost({
  host,
  children,
}: {
  host: RecordPillHostKind;
  children: ReactNode;
}) {
  return (
    <RecordPillHostContext.Provider value={host}>
      {children}
    </RecordPillHostContext.Provider>
  );
}

/** A dense table cell has its own columns for facts, whatever its host says. */
export function useRecordPillSlots(): RecordPillSlots {
  const host = HOSTS[useContext(RecordPillHostContext)];
  const dense = useDenseCell();
  return dense ? { ...host, fact: false } : host;
}

export type RecordPillFact = {
  text: string;
  /** Money that left the ledger's usual direction: a refund or a credit. */
  negative?: boolean;
};

/**
 * Noninteractive identity shared by record links and selectable record rows.
 * Slots draw in one order: mark, type, title, qualifier, fact. The title leads
 * in ink; the qualifier follows muted and truncates first; the fact never
 * truncates. Owners name the full identity accessibly; this pill only orders
 * what is drawn.
 */
export function RecordPill({
  name,
  mark,
  type,
  qualifier,
  fact,
  state,
  replaced,
}: {
  name: string;
  mark: ReactNode;
  /** The record type's shortcode prefix ("EXP"). */
  type?: string | null;
  /** A hierarchy path or the shared part of a title. */
  qualifier?: string | null;
  fact?: RecordPillFact | null;
  /** `deleted`: the record is gone. `current`: the page already shows it. */
  state?: "deleted" | "current";
  /** The code this reference named before its record merged into this one. */
  replaced?: string | null;
}) {
  const dense = useDenseCell();
  return (
    <span
      data-entity-pill=""
      data-state={state}
      className={cn(
        "inline-flex min-h-(--record-pill-height) max-w-full min-w-0 items-center gap-1 rounded-(--brand-web-radius-chip) border border-border bg-transparent py-px pr-1.5 pl-0.5 align-middle text-xs leading-none font-normal text-foreground transition-colors duration-(--brand-motion-fast)",
        state === "deleted" && "border-dashed text-muted-foreground",
        state === "current" ? "bg-muted" : "hover:bg-muted",
      )}
    >
      <span className="flex size-(--record-pill-mark) shrink-0 items-center justify-center">
        {mark}
      </span>
      {type ? (
        // Visual only: a link's accessible name stays the record's own name.
        <span aria-hidden className="shrink-0 font-mono text-muted-foreground">
          {type}
        </span>
      ) : null}
      {replaced ? (
        <span className="shrink-0 text-muted-foreground">
          <span className="font-mono line-through">{replaced}</span>{" "}
          <span aria-hidden>→</span>
        </span>
      ) : null}
      {qualifier ? (
        <span
          className={cn(
            "min-w-0",
            dense
              ? "flex items-baseline gap-1"
              : "leading-4 break-words whitespace-normal",
          )}
        >
          <span
            className={cn(
              "font-medium",
              state === "deleted" && "line-through",
              // The title gives way only once the qualifier has none left.
              dense && "min-w-0 truncate",
            )}
          >
            {name}
          </span>{" "}
          <span
            className={cn(
              "text-xs text-muted-foreground",
              dense && "min-w-0 shrink-[1000] truncate",
            )}
          >
            {qualifier}
          </span>
        </span>
      ) : (
        <span
          className={cn(
            "min-w-0",
            state === "deleted" && "line-through",
            dense ? "truncate" : "leading-4 break-words whitespace-normal",
          )}
        >
          {name}
        </span>
      )}
      {fact ? (
        <span
          className={cn(
            "shrink-0 self-stretch border-l border-border pl-1.5 font-mono tabular-nums",
            "flex items-center",
            fact.negative && "text-destructive",
          )}
        >
          {fact.text}
        </span>
      ) : null}
    </span>
  );
}
