import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { Suspense, useState, type ComponentProps } from "react";

import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { CELL_RAIL_BUTTON_CLASS } from "~/ui/data-table/cell-frame";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";

import { DecisionLevels } from "./decision-levels";
import type { WhyValueContents as LoadedWhyValueContents } from "./why-value-content";

type WhyValueProps = ComponentProps<typeof LoadedWhyValueContents>;

const DeferredContents = browserOnlyLazy<WhyValueProps>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./why-value-content").then((module) => ({
          default: module.WhyValueContents,
        })),
);
const DeferredPopoverContents = browserOnlyLazy<WhyValueProps>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./why-value-content").then((module) => ({
          default: module.WhyValuePopoverContents,
        })),
);

function ExplanationLoading({
  label,
  pendingSuggestion,
}: Pick<WhyValueProps, "label" | "pendingSuggestion">) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3">
      <PopoverTitle className="text-sm font-semibold">
        Why this value · {label}
      </PopoverTitle>
      {/* Suggestion actions stay available while the reader's code loads. */}
      {pendingSuggestion ? (
        <DecisionLevels>
          {(level) => (level === "pending" ? pendingSuggestion : null)}
        </DecisionLevels>
      ) : null}
      <p className="text-muted-foreground">Loading…</p>
    </div>
  );
}

export function WhyValue({
  entity,
  id,
  field,
  label,
  surface = "detail",
  scope,
  onSet,
  resolution,
}: WhyValueProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            mobileSize="touch"
            className={
              surface === "list"
                ? CELL_RAIL_BUTTON_CLASS
                : "relative z-[1] text-muted-foreground"
            }
            aria-label={`How ${label.toLowerCase()} is determined`}
          />
        }
      >
        <InfoIcon className={surface === "list" ? "size-3" : "size-3.5"} />
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(42rem,85dvh,var(--available-height))] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain p-0">
        {open ? (
          <Suspense fallback={<ExplanationLoading label={label} />}>
            <DeferredPopoverContents
              entity={entity}
              id={id}
              field={field}
              label={label}
              surface={surface}
              scope={scope}
              onSet={onSet}
              resolution={resolution}
            />
          </Suspense>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Direct detail and suggestion callers share the same interaction-only import. */
export function WhyValueContents(props: WhyValueProps) {
  return (
    <Suspense
      fallback={
        <ExplanationLoading
          label={props.label}
          pendingSuggestion={props.pendingSuggestion}
        />
      }
    >
      <DeferredContents {...props} />
    </Suspense>
  );
}
