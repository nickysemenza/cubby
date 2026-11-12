import type { EntityPhase } from "@cubby/schemas/entity-definitions/definition";
import {
  describeRunWait,
  jobKindDeclaration,
  type RunWaitingOn,
} from "@cubby/schemas/job";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { cn } from "cn";

import { formatInstant } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";

type StateRole =
  | "needs"
  | "stalled"
  | "failed"
  | "running"
  | "queued"
  | "paused"
  | "done"
  | "ended";

/**
 * Role decides the treatment. Needs-you, stalled and failed are filled pills;
 * running, queued, paused, done and ended are a dot or glyph and a label. A
 * wait refines an active state into queued or paused. A finished option is
 * done (positive) only when its declared colour is positive; any other
 * finished option (retried, cancelled, archived) ends neutral.
 */
function stateRole({
  phase,
  color,
  stalled,
  failed,
  wait,
}: {
  phase: EntityPhase;
  color?: string;
  stalled?: boolean;
  failed?: boolean;
  wait?: RunWaitingOn;
}): StateRole {
  if (failed) return "failed";
  if (stalled) return "stalled";
  if (phase === "needs") return "needs";
  if (phase === "finished")
    return color === "positive" || color === "var(--positive)"
      ? "done"
      : "ended";
  if (wait?.reason === "paused") return "paused";
  if (wait && wait.reason !== "in_progress") return "queued";
  return "running";
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
  const declared = jobKindDeclaration(wait.kind);
  const kind = declared?.activityLabel ?? declared?.label ?? wait.kind;
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

const pillBase =
  "inline-flex shrink-0 items-center gap-1.25 rounded-(--brand-web-radius-chip) font-semibold whitespace-nowrap";

/**
 * One state, drawn the same on a list row, the detail header and a batch row.
 * `option.color` is the option's declared tone and `phase` its `optionPhase`;
 * `reason` is muted text after the label; `wait` adds the queue position and estimate; `failed` is true for a
 * failure outcome. `size="header"` draws the larger pill and the wait's detail
 * lines.
 */
export function StateBadge({
  option,
  phase,
  reason,
  wait,
  stalled,
  failed,
  size = "row",
}: {
  option: { label: string; color?: string };
  phase: EntityPhase;
  reason?: string | null;
  wait?: RunWaitingOn;
  stalled?: boolean;
  failed?: boolean;
  size?: "row" | "header";
}) {
  const role = stateRole({
    phase,
    color: option.color,
    stalled,
    failed,
    wait,
  });
  const waitText = useWaitText(wait);
  const label = role === "stalled" ? "Stalled" : option.label;
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
    role === "needs" ? (
      <span className={cn(pill, "bg-needs text-needs-foreground")}>
        <span
          aria-hidden
          className="size-1.75 shrink-0 rounded-[1.5px] bg-needs-foreground"
        />
        {label}
      </span>
    ) : role === "stalled" ? (
      <span className={cn(pill, "bg-stalled-surface text-stalled")}>
        <WarningIcon aria-hidden weight="bold" className="size-3" />
        {label}
      </span>
    ) : role === "failed" ? (
      <span className={cn(pill, "bg-destructive-surface text-destructive")}>
        <XIcon aria-hidden weight="bold" className="size-3" />
        {label}
      </span>
    ) : (
      <span
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1.5 font-medium whitespace-nowrap",
          "text-sm",
          role === "running" && "text-running",
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
              role === "running" && "bg-running",
              role === "done" && "bg-positive",
              role === "queued" && "border-[1.5px] border-queued",
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
      className="grid min-w-0 gap-0.5"
      title={trailing ? `${label} · ${trailing}` : label}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {main}
        {trailing ? (
          <span className="min-w-0 truncate text-sm text-muted-foreground">
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
