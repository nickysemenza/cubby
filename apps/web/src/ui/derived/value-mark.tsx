import {
  fieldDecisionOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { cn } from "cn";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

function UpdatingDot({
  label = "Updating",
  active = true,
}: {
  label?: string;
  active?: boolean;
}) {
  return (
    <output
      aria-label={label}
      title={label}
      className="inline-flex size-3 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-info",
          active && "motion-safe:animate-pulse",
        )}
      />
    </output>
  );
}

/** Missing is not evidence that work is running. */
export function MissingFieldValue({
  interactive = true,
}: {
  interactive?: boolean;
}) {
  const label = "Not calculated yet";
  const detail = "No refresh is currently queued.";
  if (!interactive)
    return (
      <span
        title={`${label}. ${detail}`}
        aria-label={label}
        className="inline-flex font-sans text-muted-foreground"
      >
        <CircleDashedIcon aria-hidden="true" className="size-3" />
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex shrink-0 items-center justify-center font-sans text-muted-foreground max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          />
        }
      >
        <CircleDashedIcon aria-hidden="true" className="size-3" />
      </TooltipTrigger>
      <TooltipContent className="max-w-80 font-sans break-words">
        <p>{label}</p>
        <p>{detail}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Marks stay in the value flow, independent of hover-only cell controls. */
export function FieldValueMark({
  envelope,
  children,
  interactive = true,
}: {
  envelope?: ReadableFieldEnvelope;
  children: ReactNode;
  /** Event buttons expose full diagnostics in their inspector. */
  interactive?: boolean;
}) {
  const provenance = envelope
    ? fieldDecisionOf(envelope)?.provenance
    : undefined;
  const inherited = provenance?.kind === "inherited";
  const stale =
    envelope?.result.kind === "cached" && envelope.result.freshness === "stale";
  const missing = envelope?.result.kind === "missing";
  return (
    <span
      data-slot="derived-value"
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1",
        inherited && "text-muted-foreground",
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
      <span className="min-w-0 truncate">
        {missing ? (
          <MissingFieldValue interactive={interactive} />
        ) : (
          children
        )}
      </span>
      {!missing && stale ? (
        <UpdatingDot label="Stale result" active={false} />
      ) : null}
    </span>
  );
}
