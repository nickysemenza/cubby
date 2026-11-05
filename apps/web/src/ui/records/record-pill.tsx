import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { cn } from "cn";
import { createContext, useContext, type ReactNode } from "react";

import { Spinner } from "../primitives/spinner";
import { useDenseCell } from "../values/stacked-value";

/**
 * How a value chip wraps a record pill: a pending suggestion or an
 * automatically applied value. The pill itself becomes that one chip, so a
 * suggestion never nests a record pill inside a second chip.
 */
export type RecordPillTreatment =
  | { kind: "suggested"; busy?: boolean }
  | { kind: "auto" };

export const RecordPillTreatmentContext =
  createContext<RecordPillTreatment | null>(null);

/** The sparkle that marks machine-proposed or machine-applied values. */
export function SuggestionSparkle({ className }: { className?: string }) {
  return (
    <SparkleIcon
      aria-hidden
      weight="fill"
      className={cn("shrink-0 text-action-change", className)}
    />
  );
}

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
  const treatment = useContext(RecordPillTreatmentContext);
  const suggested = treatment?.kind === "suggested";
  return (
    <span
      data-entity-pill=""
      className={cn(
        "inline-flex min-h-(--record-pill-height) max-w-full min-w-0 items-center gap-1 rounded-(--brand-web-radius-chip) border py-px pr-1.5 pl-0.5 align-middle text-xs leading-none font-normal text-foreground transition-colors duration-(--brand-motion-fast) hover:bg-muted",
        suggested
          ? "border-dashed border-action-change/60 bg-transparent"
          : treatment?.kind === "auto"
            ? "border-transparent bg-muted"
            : "border-border bg-transparent",
      )}
    >
      <span className="flex size-(--record-pill-mark) shrink-0 items-center justify-center">
        {/* A pending suggestion's sparkle stands in for the thumbnail. */}
        {suggested ? (
          treatment.busy ? (
            <Spinner className="size-3" />
          ) : (
            <SuggestionSparkle className="size-3" />
          )
        ) : (
          mark
        )}
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
      {treatment?.kind === "auto" && <SuggestionSparkle className="size-2.5" />}
    </span>
  );
}
