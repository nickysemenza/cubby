import type { ReportRowState } from "@cubby/schemas/entity-report";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Skeleton } from "~/ui/primitives/skeleton";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";

import "./record-list.css";

export type RecordTone = "positive" | "warning" | "destructive" | "muted";

/** Query state a list renders before its rows; loading and failure never read as empty. */
export type RecordListState =
  | { status: "pending"; rows?: number }
  | { status: "error"; error: unknown; title: string; onRetry?: () => void }
  | { status: "success" };

/**
 * Every read-only record list on detail pages: a records `Ledger` with compact
 * rows, optional groups, a timeline variant and shared trailing formats.
 * Interactive record work stays in RTable.
 */
export function RecordList({
  variant = "plain",
  state = { status: "success" },
  empty,
  footer,
  children,
  className,
  ...props
}: {
  variant?: "plain" | "timeline";
  state?: RecordListState;
  /** Rendered instead of the ledger when the loaded list has no rows. */
  empty?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  if (state.status === "pending")
    return <RecordListSkeleton rows={state.rows ?? 3} />;
  if (state.status === "error")
    return (
      <ErrorDisplay
        error={state.error}
        title={state.title}
        onRetry={state.onRetry}
      />
    );
  if (empty !== undefined && isEmpty(children))
    return <p className="text-xs/5 text-muted-foreground">{empty}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Ledger data-record-list={variant} className={className} {...props}>
        {children}
      </Ledger>
      {footer}
    </div>
  );
}

const isEmpty = (children: ReactNode) =>
  children === null ||
  children === undefined ||
  children === false ||
  (Array.isArray(children) && children.every(isEmpty));

/** Placeholder rows at the loaded row height, so a section does not jump when data arrives. */
function RecordListSkeleton({ rows }: { rows: number }) {
  return (
    <div
      aria-busy
      aria-label="Loading records"
      className="flex flex-col"
      data-record-list-skeleton
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex h-7 items-center gap-3 border-t border-border/60 first:border-t-0"
        >
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * One record row. `primary` is identity (usually an `EntityRefLink`), `secondary`
 * its one-line evidence, `trailing` a short muted fact (time, score, hops).
 */
export function RecordRow({
  leading,
  primary,
  secondary,
  trailing,
  actions,
  detail,
  clip = true,
  className,
  ...props
}: {
  leading?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  /** Content beneath the row, such as an expanded diff. */
  detail?: ReactNode;
  /** Clip evidence to one line on wide rows; off for text that must wrap in full. */
  clip?: boolean;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <LedgerRow className={className} {...props}>
      {leading !== undefined ? (
        <LedgerCell slot="leading">{leading}</LedgerCell>
      ) : null}
      <LedgerCell slot="primary" className="flex min-w-0 items-center gap-1">
        {primary}
      </LedgerCell>
      {secondary !== undefined && secondary !== null ? (
        <LedgerCell
          slot="secondary"
          className={cn(
            "text-xs/5 text-muted-foreground",
            clip && "@min-[32rem]/ledger:truncate",
          )}
        >
          {secondary}
        </LedgerCell>
      ) : null}
      {trailing !== undefined && trailing !== null ? (
        <LedgerCell
          slot="trailing"
          className="text-xs/5 whitespace-nowrap text-muted-foreground"
        >
          {trailing}
        </LedgerCell>
      ) : null}
      {actions !== undefined && actions !== null ? (
        <LedgerCell slot="actions">{actions}</LedgerCell>
      ) : null}
      {detail !== undefined && detail !== null ? (
        <LedgerCell as="div" slot="detail">
          {detail}
        </LedgerCell>
      ) : null}
    </LedgerRow>
  );
}

/** A labelled run of rows: a quiet header with its count, then the rows, then "+N more". */
export function RecordGroup({
  label,
  count,
  more,
  children,
}: {
  label: ReactNode;
  count?: number;
  more?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <RecordHeading label={label} count={count} />
      {children}
      {more}
    </>
  );
}

/** A group or day heading row spanning every column. */
export function RecordHeading({
  label,
  count,
}: {
  label: ReactNode;
  count?: number;
}) {
  return (
    <LedgerRow data-record-heading>
      <LedgerCell slot="group" as="div">
        <span>{label}</span>
        {count !== undefined ? (
          <span className="tabular-nums">{count}</span>
        ) : null}
      </LedgerCell>
    </LedgerRow>
  );
}

/** The "+N more" row closing a truncated group: a route link or an in-place reveal. */
export function RecordMore({
  label,
  link,
  onClick,
}: {
  label: string;
  link?: Pick<LinkProps, "to" | "search" | "params">;
  onClick?: () => void;
}) {
  const className =
    "inline-flex min-h-6 items-center gap-0.5 text-xs/5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground";
  return (
    <LedgerRow data-record-more>
      <LedgerCell slot="group" as="div">
        {link ? (
          <Link {...link} className={className}>
            {label}
            <CaretRightIcon aria-hidden className="size-3" />
          </Link>
        ) : (
          <button type="button" className={className} onClick={onClick}>
            {label}
          </button>
        )}
      </LedgerCell>
    </LedgerRow>
  );
}

/** One muted line folding absent results, e.g. views with no connections. */
export function RecordFold({ children }: { children: ReactNode }) {
  return (
    <LedgerRow data-record-fold>
      <LedgerCell slot="group" as="div">
        {children}
      </LedgerCell>
    </LedgerRow>
  );
}

const TONE_DOT = {
  positive: "bg-positive",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "border-[1.5px] border-muted-foreground/60 bg-card",
} as const satisfies Record<RecordTone, string>;

/**
 * Each state's mark. Skipped is a hollow ring and not-reached a faint point, so neither reads as a
 * loading spinner; running pulses (record-list.css) and holds a still halo under reduced motion.
 */
const STATE_DOT = {
  done: "bg-positive",
  running: "bg-primary",
  warning: "bg-warning",
  failed: "bg-destructive",
  skipped: "border-[1.5px] border-muted-foreground/60 bg-card",
  not_reached: "size-1.5 bg-muted-foreground/35",
} as const satisfies Record<ReportRowState, string>;

/**
 * A row's mark with a label that stays readable to assistive tech: a `state` for stage and log
 * rows, a `tone` for a condition, or a `color` for a category (an event kind).
 */
export function RecordDot({
  tone,
  state,
  color,
  label,
}: {
  tone?: RecordTone | undefined;
  state?: ReportRowState | undefined;
  color?: string | undefined;
  label?: string | undefined;
}) {
  if (!label) return <span aria-hidden data-record-dot="none" />;
  return (
    <span
      className="flex h-5 items-center justify-center"
      title={label}
      data-record-dot={state ?? "tone"}
    >
      <span
        aria-hidden
        data-record-mark
        className={cn(
          "size-2 shrink-0 rounded-full",
          state
            ? STATE_DOT[state]
            : tone
              ? TONE_DOT[tone]
              : color
                ? undefined
                : "bg-foreground/50",
        )}
        style={
          color && !state && !tone ? { backgroundColor: color } : undefined
        }
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A 0–1 score as a short meter and a percentage. */
export function RecordScore({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span
        aria-hidden
        className="relative h-1 w-10 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-foreground/60"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="font-mono text-2xs">{percent}%</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** How many record hops separate a connected record from its source. */
export function RecordHops({ count }: { count: number }) {
  return (
    <span className="font-mono text-2xs">
      {count} {count === 1 ? "hop" : "hops"}
    </span>
  );
}

/** A collapsible evidence block beneath a row. */
export function RecordDetail({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group text-xs/5" open={defaultOpen || undefined}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-muted-foreground hover:text-foreground max-md:min-h-11 max-md:min-w-11 [&::-webkit-details-marker]:hidden">
        <CaretRightIcon
          aria-hidden
          className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {summary}
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}
