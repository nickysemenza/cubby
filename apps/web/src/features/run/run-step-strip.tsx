import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { type KeyNumber, KeyNumbers } from "~/ui/common/key-numbers";

import {
  type RunOverview,
  STEP_PHASE_LABEL,
  type StepSegment,
} from "./run-view-model";

const SEGMENT_TRACK = {
  done: "bg-foreground/55",
  running: "bg-info-surface",
  waiting: "bg-info-surface",
  paused: "bg-info-surface",
  failed: "bg-destructive",
  not_started: "bg-border",
} as const satisfies Record<StepSegment["phase"], string>;

function Segment({ segment }: { segment: StepSegment }) {
  const moving = segment.phase === "running" || segment.phase === "waiting";
  return (
    <span
      title={segment.label}
      data-step-segment={segment.phase}
      className={cn(
        "relative h-1.5 overflow-hidden rounded-[1px]",
        SEGMENT_TRACK[segment.phase],
      )}
    >
      {segment.tally ? (
        <span className="progress-indeterminate absolute inset-y-0 left-0 w-[30%] bg-info" />
      ) : (moving || segment.phase === "paused") &&
        segment.fraction !== null ? (
        <span
          className={cn(
            "absolute inset-y-0 left-0",
            segment.phase === "running" ? "bg-info" : "bg-info/55",
          )}
          style={{ width: `${segment.fraction * 100}%` }}
        />
      ) : null}
    </span>
  );
}

/**
 * A Run's honest overall status: the current step's own count line and one
 * segment per step, each filled by that step's frozen count. Steps count
 * their inputs when they start, so there is never one blended percentage.
 */
export function RunStepStrip({
  overview,
  figures,
  className,
}: {
  overview: RunOverview;
  /** Run-level figures (decisions by status) that drill into the ledger. */
  figures?: readonly KeyNumber[];
  className?: string;
}) {
  const { current, steps } = overview;
  if (steps.length === 0) return null;
  const later = steps.some((step) => step.phase === "not_started");
  return (
    <div className={cn("grid gap-1.5", className)} data-testid="run-step-strip">
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-sm">
        <strong className="font-semibold text-foreground-strong">
          Step {overview.currentIndex + 1} of {steps.length}
        </strong>
        {current ? (
          <>
            <span className="text-foreground">{current.label}</span>
            <span className="text-xs text-muted-foreground">
              {current.mode === "count" && current.total !== null
                ? `${formatCount(current.total - (current.left ?? 0))} of ${formatCount(current.total)} ${current.unit} done`
                : `${formatCount(current.processed)} ${current.unit} so far`}
            </span>
          </>
        ) : null}
      </p>
      <p className="sr-only">
        {steps
          .map((step) => `${step.label}: ${STEP_PHASE_LABEL[step.phase]}`)
          .join(", ")}
      </p>
      <div
        aria-hidden
        className="grid max-w-[32.5rem] gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        }}
      >
        {overview.segments.map((segment) => (
          <Segment key={segment.key} segment={segment} />
        ))}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {figures?.length ? (
          <KeyNumbers layout="inline" label="Run figures" items={figures} />
        ) : null}
        {later ? (
          <span className="text-xs text-muted-foreground">
            Later steps count their inputs when they start, so there is no
            overall percentage. Overall ETA: Unknown — later steps have not been
            estimated.
          </span>
        ) : null}
      </div>
    </div>
  );
}
