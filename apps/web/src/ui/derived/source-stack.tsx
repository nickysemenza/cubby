import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** One ordered evidence chain for reference values and read-only image strips. */
export function SourceStack({
  rows,
  label = "Value sources",
}: {
  rows: readonly {
    key: string;
    status: "deciding" | "skipped" | "blocked";
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
          className="relative grid min-h-8 grid-cols-[12px_minmax(0,1fr)] gap-x-2 py-2 before:absolute before:inset-y-0 before:left-1 before:border-l before:border-border first:before:top-3 last:before:bottom-3"
        >
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-1 size-2 rounded-full border bg-popover",
              row.status === "deciding" && "bg-foreground",
              row.status === "blocked" && "border-destructive",
            )}
          />
          <div className="grid min-w-0 gap-1">
            {row.title != null ? (
              <div
                className={cn(
                  "flex flex-wrap items-center gap-1",
                  row.status === "deciding"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {row.title}
                <span className="sr-only"> · {row.status}</span>
              </div>
            ) : (
              <span className="sr-only">{row.status}</span>
            )}
            {row.children}
          </div>
        </li>
      ))}
    </ol>
  );
}
