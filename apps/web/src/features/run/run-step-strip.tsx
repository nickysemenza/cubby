import type { ProgressValue } from "@cubby/schemas/progress";
import { cn } from "cn";

import { formatCount } from "~/lib/number-format";
import { ProgressMeter } from "~/ui/feedback/progress-meter";
import { type KeyNumber, KeyNumbers } from "~/ui/records/key-numbers";

import {
  type RunOverview,
  STEP_PHASE_LABEL,
  type StepSegment,
} from "./run-view-model";

type ProgressPart = NonNullable<ProgressValue["parts"]>[number];

const SEGMENT_STATE = {
  done: "done",
  running: "active",
  waiting: "active",
  paused: "queued",
  failed: "failed",
  not_started: "queued",
} as const satisfies Record<StepSegment["phase"], ProgressPart["state"]>;

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
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-sm tabular-nums">
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
      <ProgressMeter
        className="max-w-[32.5rem]"
        label={null}
        value={{
          done: overview.segments.filter((segment) => segment.phase === "done")
            .length,
          failed: overview.segments.filter(
            (segment) => segment.phase === "failed",
          ).length,
          active: overview.segments.filter(
            (segment) =>
              segment.phase === "running" || segment.phase === "waiting",
          ).length,
          stalled: 0,
          queued: overview.segments.filter(
            (segment) =>
              segment.phase === "paused" || segment.phase === "not_started",
          ).length,
          total: steps.length,
          unit: "steps",
          parts: overview.segments.map((segment) => ({
            label: segment.label,
            state: SEGMENT_STATE[segment.phase],
          })),
        }}
        paused={current?.phase === "paused"}
      />
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
