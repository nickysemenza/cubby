import {
  describeRunWait,
  jobKindDeclaration,
  type RunWaitingOn,
} from "@cubby/schemas/job";

import { formatInstant } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";

/**
 * The wait line on the display clock, so "about 16 min" counts down between
 * reads. Before the clock mounts (SSR) it is the server-composed label.
 */
function useRunWaitText(wait: RunWaitingOn): string {
  const now = useDisplayNow();
  return now === undefined
    ? wait.label
    : describeRunWait(wait, new Date(now), (at) => formatInstant(at, "clock"));
}

/** What the estimate rests on, for the detail line under the wait. */
function paceText(wait: RunWaitingOn): string | null {
  if (wait.position === null || wait.kind === null) return null;
  // The Work page's name for the kind.
  const declared = jobKindDeclaration(wait.kind);
  const kind = declared?.activityLabel ?? declared?.label ?? wait.kind;
  return wait.perMinute === null
    ? `No ${kind} work finished in the last ${wait.paceMinutes} minutes, so the pace is unknown.`
    : `${kind} finished ${formatCount(wait.perMinute, 1)} a minute over the last ${wait.paceMinutes} minutes.`;
}

/** One-line cell for lists; the full text stays available when it truncates. */
export function RunWaitCell({ wait }: { wait: RunWaitingOn }) {
  const text = useRunWaitText(wait);
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}

const factClass = "text-xs break-words text-muted-foreground tabular-nums";

/** The wait, then what its estimate rests on and every live Job by its own wait. */
export function RunWaitDetail({ wait }: { wait: RunWaitingOn }) {
  const text = useRunWaitText(wait);
  const pace = paceText(wait);
  return (
    <div className="grid min-w-0 gap-0.5" data-testid="run-wait">
      <p className="font-medium break-words text-foreground-strong">{text}</p>
      {pace ? <p className={factClass}>{pace}</p> : null}
      {wait.jobs ? <p className={factClass}>Live Jobs: {wait.jobs}</p> : null}
    </div>
  );
}
