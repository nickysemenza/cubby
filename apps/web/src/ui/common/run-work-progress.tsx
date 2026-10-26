import {
  readRunWorkPhase,
  type RunWorkPhase,
} from "@cubby/schemas/run-work-progress";

import { formatCount } from "~/lib/number-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "~/ui/primitives/progress";

import { useDenseCell } from "./stacked-value";

/**
 * Rates and ETA come from the recorded interval history, never browser
 * extrapolation. Counts carry their unit; a paused or stale sample names its
 * state instead of advertising a live rate, and a finished one its recorded rate.
 */
export function runProgressValue(work: RunWorkPhase) {
  const counts =
    work.total === null
      ? `${formatCount(work.processed)} ${work.unit} so far`
      : `${formatCount(work.processed)} / ${formatCount(work.total)} ${work.unit}`;
  const perMinute =
    work.ratePerSecond === null
      ? null
      : `${(work.ratePerSecond * 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${work.unit}/min`;
  const historical = work.state === "completed" || work.state === "failed";
  const rate = historical
    ? perMinute && `${perMinute} recorded`
    : work.estimateState === "paused"
      ? "Paused"
      : work.estimateState === "stale"
        ? "Stale sample"
        : perMinute;
  const current = work.estimateState === "current" && work.state === "running";
  const eta =
    current && work.etaSeconds !== null
      ? `~${Math.max(1, Math.ceil(work.etaSeconds / 60))} min left`
      : null;
  return [[counts, rate].filter(Boolean).join("; "), eta]
    .filter(Boolean)
    .join(" · ");
}

export function RunWorkProgress({
  sample,
  status,
}: {
  sample: RunWorkPhase;
  status: string;
}) {
  const dense = useDenseCell();
  const now = useDisplayNow() ?? Date.now();
  const work = readRunWorkPhase(
    sample,
    status,
    new Date(now),
    sample.state === "waiting",
  );
  const text = runProgressValue(work);
  if (work.total === null)
    return (
      <span className="text-xs text-muted-foreground">
        {work.label}; {text}
      </span>
    );
  return (
    <Progress
      value={work.processed}
      max={work.total}
      paused={work.state !== "running"}
      aria-valuetext={`${work.label}: ${text}`}
    >
      <ProgressLabel className={dense ? "sr-only" : undefined}>
        {work.label}
      </ProgressLabel>
      <ProgressValue
        className={dense ? "col-span-2 truncate" : undefined}
        title={`${work.label}: ${text}`}
      >
        {() => text}
      </ProgressValue>
    </Progress>
  );
}
