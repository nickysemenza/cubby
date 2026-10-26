import type { DerivedMeta } from "@cubby/schemas/derived-value";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

export function UpdatingDot() {
  return (
    <output
      aria-label="Updating"
      title="Updating"
      className="inline-flex size-3 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-info motion-safe:animate-pulse"
      />
    </output>
  );
}

/** Marks stay in the value flow, independent of hover-only cell controls. */
export function DerivedValue({
  meta,
  children,
}: {
  meta?: DerivedMeta;
  children: ReactNode;
}) {
  const inherited = meta?.decidedBy?.level === "inherited";
  const auto = meta?.decidedBy?.level === "suggested" && meta.decidedBy.auto;
  const updating = meta?.state === "stale" || meta?.state === "waiting";
  return (
    <span
      data-slot="derived-value"
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1",
        inherited && "text-muted-foreground",
        auto &&
          "w-fit rounded-md border border-dashed border-action-change/40 bg-action-change-surface px-1 text-action-change",
      )}
    >
      {inherited ? (
        <span
          className="w-3 shrink-0 text-muted-foreground"
          aria-label="Inherited"
        >
          ↳
        </span>
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
      {auto ? <span className="shrink-0 text-3xs">auto</span> : null}
      {updating ? <UpdatingDot /> : null}
      {meta?.state === "failed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={meta.error ?? "Derived value failed"}
                className="shrink-0 text-destructive"
              />
            }
          >
            !
          </TooltipTrigger>
          <TooltipContent className="max-w-80 break-words whitespace-pre-wrap">
            {meta.error ?? "Derived value failed"}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
