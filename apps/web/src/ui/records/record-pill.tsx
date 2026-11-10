import { cn } from "cn";
import type { ReactNode } from "react";

import { useDenseCell } from "../values/stacked-value";

/**
 * Noninteractive identity shared by record links and selectable record rows.
 * `parent` is a hierarchy path (a category's ancestors): the leaf `name` leads
 * in ink and the muted parent follows and truncates first. Owners name the
 * full root-to-leaf path accessibly; this pill only orders what is drawn.
 */
export function RecordPill({
  name,
  mark,
  parent,
}: {
  name: string;
  mark: ReactNode;
  parent?: string | null;
}) {
  const dense = useDenseCell();
  return (
    <span
      data-entity-pill=""
      className={cn(
        "inline-flex min-h-(--record-pill-height) max-w-full min-w-0 items-center gap-1 rounded-(--brand-web-radius-chip) border border-border bg-transparent py-px pr-1.5 pl-0.5 align-middle text-xs leading-none font-normal text-foreground transition-colors duration-(--brand-motion-fast) hover:bg-muted",
      )}
    >
      <span className="flex size-(--record-pill-mark) shrink-0 items-center justify-center">
        {mark}
      </span>
      {parent ? (
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
              // The leaf gives way only once the parent has none left.
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
            {parent}
          </span>
        </span>
      ) : (
        <span
          className={cn(
            "min-w-0",
            dense ? "truncate" : "leading-4 break-words whitespace-normal",
          )}
        >
          {name}
        </span>
      )}
    </span>
  );
}
