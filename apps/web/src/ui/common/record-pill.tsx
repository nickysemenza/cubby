import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useDenseCell } from "./stacked-value";

/** Noninteractive identity shared by record links and selectable record rows. */
export function RecordPill({ name, mark }: { name: string; mark: ReactNode }) {
  const dense = useDenseCell();
  return (
    <span
      data-entity-pill=""
      className="inline-flex min-h-5.5 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted py-0.5 pr-1.5 pl-0.5 align-middle text-xs leading-none font-medium text-foreground"
    >
      <span className="flex size-4.5 shrink-0 items-center justify-center">
        {mark}
      </span>
      <span
        className={cn(
          "min-w-0",
          dense ? "truncate" : "leading-4 break-words whitespace-normal",
        )}
      >
        {name}
      </span>
    </span>
  );
}
