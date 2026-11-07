import {
  fieldDecisionOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { cn } from "cn";
import { useEffect, useState, type ReactNode } from "react";

import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import {
  RecordPillTreatmentContext,
  SuggestionSparkle,
} from "~/ui/records/record-pill";

const AUTO_LABEL = "Set automatically";

type PendingWork = Extract<ReadableFieldEnvelope["work"], { kind: "pending" }>;

/** Branch on the wire attribution; refresh reasons are display text. */
export function pendingWorkLabel(work: PendingWork, running: boolean) {
  if (work.execution)
    return running ? "Updating" : "Refresh status may be out of date";
  return work.attribution === "related"
    ? "Related refresh pending"
    : "Queued for refresh";
}

/** Expire the observation locally; a timer never asserts that replacement work is queued. */
export function useFieldExecutionCurrent(execution: PendingWork["execution"]) {
  const now = useDisplayNow();
  const [expiredLease, setExpiredLease] = useState<string>();
  const expiresAt = execution?.leaseExpiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
      setExpiredLease(expiresAt);
      return;
    }
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

/** Missing is not evidence that work is running; keep the work state explicit. */
export function MissingFieldValue({
  envelope,
  interactive = true,
}: {
  envelope: ReadableFieldEnvelope;
  interactive?: boolean;
}) {
  const work = envelope.work;
  const running = useFieldExecutionCurrent(
    work.kind === "pending" ? work.execution : undefined,
  );
  if (work.kind === "failed")
    return <span className="font-sans text-muted-foreground">Unavailable</span>;
  const label =
    work.kind === "pending"
      ? pendingWorkLabel(work, running)
      : work.kind === "waiting"
        ? "Waiting to refresh"
        : "Not calculated yet";
  const detail =
    work.kind === "waiting"
      ? work.reason
      : work.kind === "idle"
        ? "No refresh is currently queued."
        : null;
  const Icon = running
    ? ArrowClockwiseIcon
    : work.kind === "pending" || work.kind === "waiting"
      ? ClockIcon
      : CircleDashedIcon;
  if (!interactive)
    return (
      <span
        title={detail ? `${label}. ${detail}` : label}
        aria-label={label}
        className="inline-flex font-sans text-muted-foreground"
      >
        <Icon
          aria-hidden="true"
          className={cn("size-3", running && "motion-safe:animate-spin")}
        />
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex shrink-0 items-center font-sans text-muted-foreground"
          />
        }
      >
        <Icon
          aria-hidden="true"
          className={cn("size-3", running && "motion-safe:animate-spin")}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-80 font-sans break-words">
        <p>{label}</p>
        {detail ? <p>{detail}</p> : null}
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
  const refreshLabel =
    envelope?.work.kind === "pending"
      ? pendingWorkLabel(envelope.work, running)
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
        // An automatic value is a settled neutral chip; a record value's own
        // pill carries the chip and sparkle, so this wrapper steps aside.
        auto &&
          "group/auto h-(--pill-height) w-fit rounded-(--brand-web-radius-chip) bg-muted px-1.5 has-data-entity-pill:h-auto has-data-entity-pill:bg-transparent has-data-entity-pill:px-0",
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
        {missing && envelope ? (
          <MissingFieldValue envelope={envelope} interactive={interactive} />
        ) : auto ? (
          <RecordPillTreatmentContext.Provider value={{ kind: "auto" }}>
            {children}
          </RecordPillTreatmentContext.Provider>
        ) : (
          children
        )}
      </span>
      {auto ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex shrink-0 group-has-data-entity-pill/auto:sr-only" />
            }
          >
            <SuggestionSparkle className="size-2.5" />
            <span className="sr-only">{AUTO_LABEL}</span>
          </TooltipTrigger>
          <TooltipContent>{AUTO_LABEL}</TooltipContent>
        </Tooltip>
      ) : null}
      {!missing && updating && error === null ? (
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
