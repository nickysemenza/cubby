import { cn } from "cn";
import type { ReactNode } from "react";

import { Skeleton } from "~/ui/primitives/skeleton";

import "~/ui/data-table/record-workspace.css";

/** One Today card on the page canvas: a section with its heading and link. */
export function HomeCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("record-card", className)}>{children}</div>;
}

/** Home's ruled rows: one 32px line each, a hairline under every row. */
export function HomeList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ul aria-label={label} className="min-w-0">
      {children}
    </ul>
  );
}

export function HomeRow({
  leading,
  trailing,
  className,
  children,
}: {
  /** A quiet 52px label column: a day, a meal slot, a month. */
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex min-h-(--table-row-height) min-w-0 items-center gap-2 border-b border-border text-sm max-md:min-h-11",
        className,
      )}
    >
      {leading != null && (
        <span className="w-13 shrink-0 truncate text-xs text-muted-foreground">
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">{children}</span>
      {trailing != null && (
        <span className="flex shrink-0 items-center gap-2 text-right tabular-nums">
          {trailing}
        </span>
      )}
    </li>
  );
}

/**
 * One ledger line with nothing to open: a name, its one-line digest and the
 * figure on the right. Without a digest the name takes its place.
 */
export function HomeLedgerLine({
  name,
  digest,
  figure,
}: {
  name: ReactNode;
  digest?: ReactNode;
  figure?: ReactNode;
}) {
  return (
    <li className="record-ledger-line">
      <span
        className={cn(
          "record-ledger-name flex items-center gap-1.5",
          digest == null && "col-span-2",
        )}
      >
        {name}
      </span>
      {digest != null && <span className="record-ledger-digest">{digest}</span>}
      <span className="record-ledger-figure col-start-3 text-right">
        {figure}
      </span>
    </li>
  );
}

export function HomeRowsLoading({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <output aria-label={label} className="block">
      {Array.from({ length: rows }, (_, index) => (
        <span
          key={index}
          className="flex min-h-8 items-center border-b border-border max-md:min-h-11"
        >
          <Skeleton className="h-4 w-3/5" />
        </span>
      ))}
    </output>
  );
}
