import type { ProgressValue } from "@cubby/schemas/progress";
import { cn } from "cn";
import type { ReactNode } from "react";

import { formatCount } from "~/lib/number-format";
import { roundTo } from "~/lib/round-to";

/** A total of this many units or fewer draws one segment per unit. */
const SEGMENT_LIMIT = 12;

type UnitState = "done" | "active" | "failed" | "stalled" | "queued";

const unitClass = {
  done: "bg-progress-done",
  active: "bg-running",
  failed: "bg-destructive",
  stalled: "bg-stalled-mark",
  // Hollow always means queued or missing.
  queued: "bg-transparent ring-1 ring-queued ring-inset",
} satisfies Record<UnitState, string>;

const pausedClass = "bg-paused";

const drawClass = (state: UnitState, paused: boolean) =>
  paused && state === "done" ? pausedClass : unitClass[state];

type Segment = { id: string; state: UnitState; label?: string };

/** The counted units in draw order; whatever is unaccounted for is queued. */
function segments(value: ProgressValue, total: number): Segment[] {
  const seen = new Map<UnitState, number>();
  const make = (state: UnitState, label?: string): Segment => {
    const n = (seen.get(state) ?? 0) + 1;
    seen.set(state, n);
    return { id: `${state}-${n}`, state, label };
  };
  if (value.parts)
    return value.parts.map((part) => make(part.state, part.label));
  const out: Segment[] = [];
  const push = (state: UnitState, count: number) => {
    for (let n = 0; n < count && out.length < total; n += 1)
      out.push(make(state));
  };
  push("done", value.done);
  push("failed", value.failed);
  push("active", value.active);
  push("stalled", value.stalled);
  push("queued", total);
  return out;
}

function labelText(value: ProgressValue): string {
  return value.total === null
    ? `${value.done} ${value.unit}`
    : `${value.done} of ${formatCount(value.total)} ${value.unit}`;
}

const dashes = Array.from({ length: 40 }, (_, n) => `dash-${n}`);

function Track({
  value,
  paused,
  variant,
  title,
}: {
  value: ProgressValue;
  paused: boolean;
  variant: "row" | "block";
  title: string;
}) {
  const size = variant === "row" ? "h-1.25 w-10 shrink-0" : "h-1.5 w-full";
  const { total } = value;
  const a11y = {
    role: "progressbar",
    "aria-label": title,
    "aria-valuemin": 0,
    "aria-valuenow": value.done,
    "aria-valuemax": total ?? undefined,
    "aria-valuetext": total === null ? `${title}, total unknown` : title,
  } as const;

  if (total === null)
    return (
      <span {...a11y} className={cn("flex gap-1 overflow-hidden", size)}>
        {dashes.slice(0, variant === "row" ? 5 : 40).map((id) => (
          <i key={id} className="w-1 shrink-0 rounded-[1px] bg-running" />
        ))}
      </span>
    );

  if (total <= SEGMENT_LIMIT)
    return (
      <span {...a11y} className={cn("flex gap-0.5", size)}>
        {segments(value, total).map((segment) => (
          <i
            key={segment.id}
            title={segment.label}
            className={cn(
              "min-w-px flex-1 rounded-[1.5px]",
              drawClass(segment.state, paused),
            )}
          />
        ))}
      </span>
    );

  const parts = (
    [
      ["done", value.done],
      ["failed", value.failed],
      ["active", value.active],
      ["stalled", value.stalled],
      ["queued", value.queued],
    ] as const
  ).filter(([, count]) => count > 0);
  return (
    <span
      {...a11y}
      className={cn(
        "flex gap-0.5 overflow-hidden rounded-[1.5px] bg-progress-track",
        size,
      )}
    >
      {parts.map(([state, count]) => (
        <span
          key={state}
          className={cn("h-full shrink-0", drawClass(state, paused))}
          style={{ width: `calc(${roundTo((100 * count) / total, 2)}% - 2px)` }}
        />
      ))}
    </span>
  );
}

/**
 * A `ProgressValue` for a plain counted operation: `done` of `total` (`null`
 * when unknown) with `failed` among the settled and the rest queued.
 */
export function countedProgress({
  done,
  total,
  unit,
  failed = 0,
  active = 0,
}: {
  done: number;
  total: number | null;
  unit: string;
  failed?: number;
  active?: number;
}): ProgressValue {
  return {
    done,
    failed,
    active,
    stalled: 0,
    queued: total === null ? 0 : Math.max(0, total - done - failed - active),
    total,
    unit,
  };
}

/**
 * How far work has come, drawn from the counts alone. A total of 12 or fewer
 * is one segment per unit (named when `value.parts` is given), a larger one is
 * a proportional bar, and a `null` total is an indeterminate dashed track with
 * the running count. `row` is a 40x5 track beside its label; `block` is a
 * full-width track over its label. `label` replaces the default
 * "{done} of {total} {unit}"; `note` is appended in muted text; `paused`
 * draws completed work in the paused colour.
 */
export function ProgressMeter({
  value,
  label,
  note,
  variant = "block",
  paused = false,
  className,
}: {
  value: ProgressValue;
  /** Replaces the default text; `null` draws the track alone. */
  label?: ReactNode | null;
  note?: string;
  variant?: "row" | "block";
  paused?: boolean;
  className?: string;
}) {
  const text = labelText(value);
  const title = note ? `${text} · ${note}` : text;
  return (
    <span
      data-progress-meter=""
      title={title}
      // Bounded by the cell, not its inline wrappers, so a narrow column ends
      // the note, then the count, in an ellipsis instead of clipping.
      className={cn(
        "flex max-w-full min-w-0",
        variant === "row"
          ? "items-center gap-2"
          : "flex-col items-stretch gap-1.25",
        className,
      )}
    >
      <Track value={value} paused={paused} variant={variant} title={title} />
      {label === null ? null : (
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {label ?? (
            <>
              <b className="font-medium text-foreground">{value.done}</b>
              {text.slice(String(value.done).length)}
            </>
          )}
          {note ? <> · {note}</> : null}
        </span>
      )}
    </span>
  );
}
