import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { cn } from "cn";
import type { ReactNode } from "react";

type SourceStatus = "deciding" | "skipped" | "blocked" | "gap" | "failed";

/**
 * One ordered evidence chain: Why this value's levels, the machinery panel's
 * gaps and inputs, and read-only image strips. `statusLabel` prints the row's
 * status as a visible word; without it the status is announced only.
 */
export function SourceStack({
  rows,
  label = "Value sources",
}: {
  rows: readonly {
    key: string;
    status: SourceStatus;
    statusLabel?: string;
    title: ReactNode;
    children?: ReactNode;
  }[];
  label?: string;
}) {
  return (
    <ol aria-label={label} className="grid gap-0 text-xs">
      {rows.map((row) => (
        <li
          key={row.key}
          data-source-status={row.status}
          className="relative grid min-h-8 grid-cols-[12px_minmax(0,1fr)] gap-x-2 py-2 before:absolute before:inset-y-0 before:left-1 before:border-l before:border-border first:before:top-3 last:before:bottom-3"
        >
          {row.status === "failed" ? (
            <XIcon
              aria-hidden="true"
              weight="bold"
              className="relative mt-0.5 size-2.5 bg-popover text-destructive"
            />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "relative mt-1 size-2 rounded-full border bg-popover",
                row.status === "deciding" && "bg-foreground",
                row.status === "blocked" && "border-destructive",
                row.status === "gap" && "border-dashed border-foreground",
              )}
            />
          )}
          <div className="grid min-w-0 gap-1">
            {row.title != null ? (
              <div
                className={cn(
                  "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5",
                  row.status === "deciding" || row.status === "gap"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {row.statusLabel ? (
                  <span className="shrink-0 text-xs font-medium text-foreground">
                    {row.statusLabel}
                  </span>
                ) : null}
                {typeof row.title === "string" ? (
                  <span className="min-w-0 break-words">{row.title}</span>
                ) : (
                  row.title
                )}
                {row.statusLabel ? null : (
                  <span className="sr-only"> · {row.status}</span>
                )}
              </div>
            ) : (
              <span className="sr-only">{row.statusLabel ?? row.status}</span>
            )}
            {row.children}
          </div>
        </li>
      ))}
    </ol>
  );
}
