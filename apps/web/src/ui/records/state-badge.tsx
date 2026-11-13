import type { EntityPhase } from "@cubby/schemas/entity-definitions/definition";
import { describeRunWait, type RunWaitingOn } from "@cubby/schemas/execution";
import { kernelStageLabel } from "@cubby/schemas/field-envelope-presentation";
import type { KernelStage } from "@cubby/schemas/kernel/stage";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { cn } from "cn";

import { formatInstant } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";

/**
 * A state's treatment is its stage (ADR 0029 section 10): needs you and stuck
 * are filled pills; working, waiting, done and ended are a dot or glyph and a
 * label. `paused` is a waiting state drawn with the pause glyph.
 */
type StateRole = KernelStage | "paused";

/**
 * The declared stage, else the phase's (needs is Needs you, finished is
 * Ended, active is Working). Stalled work is Stuck; a wait refines Working
 * into Waiting or paused. Colour never decides the role.
 */
function stateRole({
  phase,
  stage,
  stalled,
  wait,
}: {
  phase: EntityPhase;
  stage?: KernelStage;
  stalled?: boolean;
  wait?: RunWaitingOn;
}): StateRole {
  if (stalled) return "stuck";
  const declared =
    stage ??
    (phase === "needs"
      ? "needs_you"
      : phase === "finished"
        ? "ended"
        : "working");
  if (declared !== "working" && declared !== "waiting") return declared;
  if (wait?.reason === "paused") return "paused";
  if (wait && wait.reason !== "in_progress") return "waiting";
  return declared;
}

/** The wait on the display clock, so "about 16 min" counts down between reads. */
function useWaitText(wait: RunWaitingOn | undefined): string | null {
  const now = useDisplayNow();
  if (!wait) return null;
  return now === undefined
    ? wait.label
    : describeRunWait(wait, new Date(now), (at) => formatInstant(at, "clock"));
}

/** What the estimate rests on, for the header's detail line. */
function paceText(wait: RunWaitingOn): string | null {
  if (wait.position === null || wait.kind === null) return null;
  const kind = wait.kind;
  return wait.perMinute === null
    ? `No ${kind} work finished in the last ${wait.paceMinutes} minutes, so the pace is unknown.`
    : `${kind} finished ${formatCount(wait.perMinute, 1)} a minute over the last ${wait.paceMinutes} minutes.`;
}

/** Drops a leading repeat of the label so "Queued" is not followed by "Queued ·". */
function withoutLabel(text: string, label: string): string {
  const head = `${label} · `;
  return text.toLowerCase().startsWith(head.toLowerCase())
    ? text.slice(head.length)
    : text;
}

/**
 * The needs and failed marks, shared by the badge and the detail side's
 * Needs you rows: needs is a square, failed an X, so the two never differ by
 * colour alone.
 */
export function StateMark({
  kind,
  className,
}: {
  kind: "needs" | "failed";
  className?: string;
}) {
  return kind === "failed" ? (
    <XIcon
      aria-hidden
      weight="bold"
      className={cn("size-3 shrink-0 text-destructive", className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "size-1.75 shrink-0 rounded-[1.5px] bg-needs-foreground",
        className,
      )}
    />
  );
}

const pillBase =
  "inline-flex shrink-0 items-center gap-1.25 rounded-(--brand-web-radius-chip) font-semibold whitespace-nowrap";

/**
 * One state, drawn the same on a list row, the detail header and a batch row.
 * `option.stage` is the option's declared stage and `phase` its `optionPhase`;
 * `reason` is muted text after the label; `wait` adds the queue position and
 * estimate. `size="header"` draws the larger pill and the wait's detail lines.
 */
export function StateBadge({
  option,
  phase,
  reason,
  wait,
  stalled,
  size = "row",
}: {
  option: { label: string; stage?: KernelStage };
  phase: EntityPhase;
  reason?: string | null;
  wait?: RunWaitingOn;
  stalled?: boolean;
  size?: "row" | "header";
}) {
  const role = stateRole({ phase, stage: option.stage, stalled, wait });
  const waitText = useWaitText(wait);
  const label = stalled ? kernelStageLabel("stuck") : option.label;
  const trailing =
    reason ?? (waitText ? withoutLabel(waitText, option.label) : null);
  const header = size === "header";
  const pill = cn(
    pillBase,
    header ? "h-6 px-2 text-sm" : "h-5 px-1.5 text-2xs",
  );
  const pace = header && wait ? paceText(wait) : null;
  const jobs = header && wait?.jobs ? `Live Jobs: ${wait.jobs}` : null;

  const main =
    role === "needs_you" ? (
      <span className={cn(pill, "bg-needs text-needs-foreground")}>
        <StateMark kind="needs" />
        {label}
      </span>
    ) : role === "stuck" && stalled ? (
      <span className={cn(pill, "bg-stalled-surface text-stalled")}>
        <WarningIcon aria-hidden weight="bold" className="size-3" />
        {label}
      </span>
    ) : role === "stuck" ? (
      <span className={cn(pill, "bg-destructive-surface text-destructive")}>
        <StateMark kind="failed" />
        {label}
      </span>
    ) : (
      <span
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1.5 font-medium whitespace-nowrap",
          "text-sm",
          role === "working" && "text-running",
          role === "done" && "text-positive",
        )}
      >
        {role === "paused" ? (
          <PauseIcon
            aria-hidden
            weight="bold"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              role === "working" && "bg-running",
              role === "done" && "bg-positive",
              role === "waiting" && "border-[1.5px] border-queued",
              role === "ended" && "bg-muted-foreground",
            )}
          />
        )}
        {label}
      </span>
    );

  return (
    <span
      data-state-role={role}
      // Bounded by the cell, not its inline wrappers: a narrow column clipped
      // the reason mid-word instead of ending it in an ellipsis.
      className="grid max-w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5"
      title={
        !header ? (trailing ? `${label} · ${trailing}` : label) : undefined
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {main}
        {trailing ? (
          <span
            className={cn(
              "min-w-0 text-sm text-muted-foreground",
              header ? "break-words" : "truncate",
            )}
          >
            {trailing}
          </span>
        ) : null}
      </span>
      {pace ? (
        <span className="text-xs break-words text-muted-foreground">
          {pace}
        </span>
      ) : null}
      {jobs ? (
        <span className="text-xs break-words text-muted-foreground">
          {jobs}
        </span>
      ) : null}
    </span>
  );
}
