import type { JobState } from "@cubby/schemas/job";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";

import type { LimitBinding } from "~/contracts/job.contract";
import type { StepWait } from "~/features/run/run-view-model";
import { EnumPill } from "~/ui/primitives/enum-pill";

const TONE = {
  info: "var(--info)",
  positive: "var(--positive)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  neutral: "var(--neutral-status)",
} as const;
export type StatusTone = keyof typeof TONE;

/** A condition chip: StatusValue geometry with a tone surface. */
export function StatusPill({
  tone,
  icon,
  children,
}: {
  tone: StatusTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <EnumPill optionRole="status" color={TONE[tone]} icon={icon}>
      {children}
    </EnumPill>
  );
}

const JOB_STATE_TONE = {
  queued: "neutral",
  running: "info",
  retry_wait: "warning",
  paused: "warning",
  completed: "positive",
  failed: "destructive",
  cancelled: "neutral",
} as const satisfies Record<JobState, StatusTone>;

export const JOB_STATE_LABEL = {
  queued: "queued",
  running: "running",
  retry_wait: "retry wait",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<JobState, string>;

export function JobStatePill({ state }: { state: JobState }) {
  return (
    <StatusPill tone={JOB_STATE_TONE[state]}>
      {JOB_STATE_LABEL[state]}
    </StatusPill>
  );
}

/** Why work is not moving: a tone pill, its window, and the raw stored detail. */
export function WaitNotice({ wait }: { wait: StepWait }) {
  const tone =
    wait.reason === "retry"
      ? "warning"
      : wait.reason === "ai_funding_window"
        ? "warning"
        : "info";
  return (
    <div className="grid gap-1.5" data-testid="wait-notice">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={tone} icon={<HourglassIcon />}>
          {wait.label}
        </StatusPill>
        {wait.until ? (
          <span className="text-xs text-muted-foreground">{wait.until}</span>
        ) : null}
      </div>
      {wait.raw ? (
        <pre className="max-h-[30vh] overflow-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-xs/4.25 break-words whitespace-pre-wrap text-foreground">
          {wait.raw}
        </pre>
      ) : null}
    </div>
  );
}

/** The limits catalog's verdict: Binding with its evidence, Not limiting, or Unknown. */
export function BindingBadge({ binding }: { binding: LimitBinding }) {
  if (binding.status === "binding")
    return <StatusPill tone="warning">Binding</StatusPill>;
  if (binding.status === "unknown")
    return <StatusPill tone="neutral">Unknown</StatusPill>;
  return <StatusPill tone="neutral">Not limiting</StatusPill>;
}
