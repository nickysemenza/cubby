import {
  fieldDecisionOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { fieldMissingLabel } from "@cubby/schemas/field-envelope-presentation";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

/** Expire the observation locally; a timer never asserts that replacement work is queued. */
export function useFieldExecutionCurrent(
  execution: Extract<
    ReadableFieldEnvelope["work"],
    { kind: "pending" }
  >["execution"],
) {
  const now = useDisplayNow();
  const [expiredLease, setExpiredLease] = useState<string>();
  const expiresAt = execution?.leaseExpiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpiredLease(expiresAt), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return (
    expiresAt !== undefined &&
    expiredLease !== expiresAt &&
    now !== undefined &&
    Date.parse(expiresAt) > now
  );
}

export function UpdatingDot({
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
  const auto =
    provenance?.kind === "own" &&
    provenance.ownership.kind === "automatic" &&
    envelope?.current.assignment?.kind === "value" &&
    envelope.current.assignment.ownership.kind === "automatic" &&
    provenance.ownership.receiptId ===
      envelope.current.assignment.ownership.receiptId;
  const updating =
    envelope?.work.kind === "pending" ||
    envelope?.work.kind === "waiting" ||
    (envelope?.result.kind === "cached" &&
      envelope.result.freshness === "stale");
  const error = envelope?.work.kind === "failed" ? envelope.work.error : null;
  const execution =
    envelope?.work.kind === "pending" ? envelope.work.execution : undefined;
  const running = useFieldExecutionCurrent(execution);
  const refreshLabel = running
    ? "Updating"
    : execution
      ? "Refresh status may be out of date"
      : envelope?.work.kind === "pending"
        ? "Queued for refresh"
        : envelope?.work.kind === "waiting"
          ? "Waiting to refresh"
          : "Stale result";
  const missing = envelope?.result.kind === "missing";
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
      <span className="min-w-0 truncate">
        {missing && envelope ? fieldMissingLabel(envelope.work) : children}
      </span>
      {auto ? <span className="shrink-0 text-3xs">auto</span> : null}
      {updating && error === null ? (
        <UpdatingDot label={refreshLabel} active={running} />
      ) : null}
      {error !== null && !interactive ? (
        <span title={error} className="shrink-0 text-destructive">
          <span aria-hidden="true">!</span>
          <span className="sr-only">{error}</span>
        </span>
      ) : error !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={error}
                className="shrink-0 text-destructive"
              />
            }
          >
            !
          </TooltipTrigger>
          <TooltipContent className="max-w-80 break-words whitespace-pre-wrap">
            {error}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
