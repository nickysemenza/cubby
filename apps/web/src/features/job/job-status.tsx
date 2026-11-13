import { kernelStageLabel } from "@cubby/schemas/field-envelope-presentation";
import type { JobState } from "@cubby/schemas/job";
import type { KernelStage } from "@cubby/schemas/kernel/stage";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";

import type { StepWait } from "~/features/run/run-view-model";
import { StateBadge } from "~/ui/records/state-badge";
import { EnumPill } from "~/ui/text/enum-pill";

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

/** Each Job state as its stage; `StateBadge` draws it. */
const JOB_STATE_STAGE = {
  queued: "waiting",
  running: "working",
  retry_wait: "waiting",
  paused: "waiting",
  completed: "done",
  failed: "stuck",
  cancelled: "ended",
} as const satisfies Record<JobState, KernelStage>;

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
  const stage = JOB_STATE_STAGE[state];
  return (
    <StateBadge
      option={{ label: kernelStageLabel(stage), stage }}
      phase={stage === "done" || stage === "ended" ? "finished" : "active"}
      reason={JOB_STATE_LABEL[state]}
    />
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
